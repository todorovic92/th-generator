# Thumbnail Generator

Monorepo for a production-minded thumbnail generation pipeline: scan a filesystem for videos, enqueue work via **BullMQ**, generate thumbnails with an injectable ffmpeg process, store binary objects behind `IObjectStorage`, and persist metadata in **Postgres**.

**Node.js 24** (current LTS) · TypeScript · npm workspaces · Turborepo

Root scripts run through [Turborepo](https://turborepo.com) (`turbo.json`). It builds packages in dependency order, runs independent ones in parallel, and caches results in `.turbo/`, so unchanged packages are skipped. `npm run generator` / `npm run scanner` build just that service and its dependencies before starting.

## Architecture

```
┌─────────────┐     BullMQ / Redis      ┌──────────────────┐
│   Scanner   │ ──────────────────────► │    Generator     │
│  (discover) │   thumbnail-generation  │  (N workers ×    │
└──┬───┬───┬──┘         queue            │   concurrency)   │
   │   │   │                            └─────┬──────┬─────┘
   │   │   └── reads ───────────────────────► │      │
   ▼   └────── reads ─────────────────────────┼────► │
 IFileSystem                           IObjectStorage  IThumbnailRepository
 (local / remote FS)                   (local → S3)    (Postgres)
```

The scanner reads storage (is the thumbnail still there?) and Postgres (is this video
durably `failed`?) before enqueueing; only the generator writes to them.

| Package / service                 | Role                                                                       |
| --------------------------------- | -------------------------------------------------------------------------- |
| `@thumbnail-generator/logger`     | Multi-level structured JSON logger                                         |
| `@thumbnail-generator/config`     | Env parsing (Redis, Postgres, paths) + `ConfigurationError`                |
| `@thumbnail-generator/queue`      | Scanner ↔ generator contract: queue name, job payload/result, job defaults |
| `@thumbnail-generator/errors`     | `AppError` base + `isRetryableError` only                                  |
| `@thumbnail-generator/filesystem` | `IFileSystem`, recursive video scanner, `FileSystemError`                  |
| `@thumbnail-generator/storage`    | `IObjectStorage` (local filesystem), `StorageError`                        |
| `@thumbnail-generator/db`         | `IThumbnailRepository`, Postgres, in-memory test double, `DatabaseError`   |
| `@thumbnail-generator/scanner`    | Entry point: finds videos, enqueues idempotent jobs                        |
| `@thumbnail-generator/generator`  | Entry point: BullMQ worker, ffmpeg, stores objects + metadata              |

`config`, `queue`, `errors` and `logger` have no internal dependencies. Each concrete error lives in the package that throws it; only the small `AppError` base is shared, so the worker can classify any failure as retryable or permanent. Services are entry points (`main.ts`), not libraries — they export nothing.

### Design choices (interview notes)

**Constructor injection + composition root (not a DI framework)**  
Services take interfaces (`IFileSystem`, `IObjectStorage`, `IThumbnailRepository`, `StartThumbnailProcess`, `ILogger`). `container.ts` wires concretes once. Unit tests construct services with mocks / `InMemoryThumbnailRepository` — no container needed.

**Binary vs metadata**  
Object bytes live in storage (`IObjectStorage`). Rows in Postgres hold path, key, location, sizes, status, timing, and errors — queryable without listing a bucket.

**Scalability of the generator**

- Horizontal: run more generator processes on the same Redis queue.
- Vertical: raise `WORKER_CONCURRENCY` per process.
- Both scanner and generator run migrations on startup. Migrations hold a Postgres advisory lock, so concurrent starts are safe, and they verify the existing schema (unique `video_path`, exact `status` check) instead of trusting `IF NOT EXISTS`.

**Idempotency**

- Scanner uses a deterministic `jobId` (hash of the video path) and a short Redis publish lock per path, so concurrent scanners don't double-enqueue.
- Scanner skips a path when its job is in flight or completed with the thumbnail present, or when Postgres has a durable `failed` row. If either check errors, it skips rather than enqueues.
- Generator skips work when metadata is already `completed` and the object exists, or when the object exists (and then upserts metadata).

**Errors**

- Typed `AppError` hierarchy with `retryable` flags; non-retryable errors become BullMQ `UnrecoverableError` (no further attempts). Jobs get 3 attempts with backoff.
- Transient failures (disk full, I/O errors, timeouts, DB/Redis blips) are retried. That includes errors reading the source video, such as permission denied, too many open files or a flaky mount. A video is "missing" only when the filesystem reports it definitively absent (`ENOENT` / `ENOTDIR` → `PathNotFoundError`).
- Permanent failures (corrupt media, missing video, permission denied, read-only filesystem) are written as `status=failed` in Postgres. That row is what stops the scanner re-enqueueing the video after BullMQ garbage-collects the failed job. If the `failed` row itself can't be written, the job is retried instead, so a permanent failure is never dropped without a record.
- To retry a durably failed video, delete or reset its row in `thumbnails`.

**Local storage**

- Object keys are single filenames (`<video-name>-<hash>.jpg`), stored directly under `THUMBNAIL_STORAGE_PATH`. Nested keys, `..` and hidden names are rejected.
- Writes go to a `.tg-staging-*.tmp` file and are atomically renamed into place; symlinks at an object path are never followed.
- The generator removes staging files older than an hour on startup (best-effort; undeletable ones are logged, not fatal).
- The storage root itself is trusted: protecting against someone who can write to it or its parent is out of scope.

## Quick start

```bash
# Node 24
nvm use

# Install
npm install

# Redis + Postgres (auth required — see .env.example)
cp .env.example .env   # set REDIS_PASSWORD / POSTGRES_*
npm run docker:up

# Build all packages
npm run build

# Put videos in data/videos/, then:
npm run generator   # terminal 1 — worker
npm run scanner     # terminal 2 — scan once & enqueue
```

Either service can start first; both run migrations. Thumbnails land in `data/thumbnails/` as flat files (`<video-name>-<hash>.jpg`). Metadata is in the `thumbnails` table.

```bash
docker exec -it thumbnail-generator-postgres \
  psql -U thumbnail -d thumbnail_generator -c 'SELECT video_path, thumbnail_key, status, error_message FROM thumbnails;'
```

### Environment

Copy `.env.example`. Important vars:

| Variable                       | Default                     | Meaning                                                            |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------ |
| `REDIS_HOST` / `REDIS_PORT`    | `127.0.0.1` / `6379`        | BullMQ broker                                                      |
| `REDIS_PASSWORD`               | —                           | Required; must match `docker-compose.yml`                          |
| `POSTGRES_*` or `DATABASE_URL` | local defaults              | Thumbnail metadata DB (scanner and generator)                      |
| `VIDEO_SCAN_PATH`              | `./data/videos`             | Scanner root                                                       |
| `SCAN_INTERVAL_MS`             | `0`                         | `0` = once; else daemon interval                                   |
| `REQUEUE_FAILED_JOBS`          | `false`                     | Re-enqueue jobs that exhausted retries (can loop on corrupt files) |
| `THUMBNAIL_STORAGE_PATH`       | `./data/thumbnails`         | Local object store root; the scanner reads it too                  |
| `WORKER_CONCURRENCY`           | `2`                         | Parallel jobs per generator process                                |
| `FFMPEG_TIMEOUT_MS`            | `120000`                    | Total ffmpeg budget per job, across seek retries                   |
| `WORKER_LOCK_DURATION_MS`      | `FFMPEG_TIMEOUT_MS + 60000` | BullMQ job lock; must be ≥ that sum                                |
| `LOG_LEVEL`                    | `INFO`                      | `DEBUG` … `SILENT`                                                 |

### Full stack via Compose

```bash
docker compose --profile full up --build
```

Starts Redis + Postgres + scanner + generator. The scanner runs as a daemon (`SCAN_INTERVAL_MS=30000`) and mounts the thumbnails volume read-only.

Both images come from the root `Dockerfile`, selected with a build arg. `turbo prune --docker` reduces the repo to that service and its internal packages. Dependencies install from manifests alone, so source edits reuse the `npm ci` layer. The runtime image gets only each workspace's `package.json` and `dist/` plus production `node_modules`; ffmpeg is installed only for the generator:

```bash
docker build --build-arg SERVICE=generator -t thumbnail-generator/generator .
```

## Tests

```bash
npm test
```

`npm test` (`turbo run test`) builds and type-checks each package, then runs its Vitest suite; packages whose inputs haven't changed are replayed from cache. Unit tests need no ffmpeg, Redis or Postgres.

Against a real broker/database, set `CI=true` or `RUN_INTEGRATION=true` (GitHub Actions does this). Those suites exercise the publish-lock Lua against Redis and `migrate()` / UNIQUE / status CHECK against Postgres; they fail the run if the services are required and unreachable.

`npm run lint` runs ESLint in every workspace.

Coverage:

- logger, errors, config parsing, queue contract
- video scanner and local storage (key rules, symlink handling, staging cleanup, permission errors)
- DB: repository (mocked pool and in-memory), migrations and schema verification; optional live Postgres
- scanner: job publisher (dedup, publish lock, durable-failure checks) and scan orchestration; optional live Redis Lua
- generator: thumbnail service (mocked ffmpeg) and failure classification (retryable vs permanent)

## Swapping storage to S3

1. Implement `IObjectStorage` in `packages/storage` (same shape as `LocalObjectStorage`).
2. Wire it in both `services/generator/src/container.ts` and `services/scanner/src/container.ts` (the scanner checks existence).
3. Drop the generator's `removeStaleStagingFiles()` call. It is specific to local storage.
4. No changes to `ThumbnailService` or the worker; metadata still points at `location` / `thumbnail_key`.

## Project layout

```
packages/
  logger/ config/ queue/ errors/ filesystem/ storage/ db/
services/
  scanner/   # enqueue
  generator/ # workers
data/        # gitignored except .gitkeep — put local videos here
  videos/ thumbnails/
Dockerfile   # one image definition, --build-arg SERVICE=generator|scanner
docker-compose.yml
.github/workflows/ci.yml
turbo.json   # task graph + caching
```
