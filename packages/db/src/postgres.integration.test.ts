import { describe, it, expect, afterAll } from 'vitest';
import pg from 'pg';
import { PostgresDatabase } from './postgres-database.js';

const required = process.env.CI === 'true' || process.env.RUN_INTEGRATION === 'true';
const host = process.env.POSTGRES_HOST ?? '127.0.0.1';
const port = Number(process.env.POSTGRES_PORT ?? '5432');
const user = process.env.POSTGRES_USER ?? 'postgres';
const password = process.env.POSTGRES_PASSWORD ?? 'postgres';
const database = process.env.POSTGRES_DB ?? 'thumbnail_generator';

async function connect(): Promise<{ db: PostgresDatabase; raw: pg.Pool }> {
  const probe = new pg.Pool({
    host,
    port,
    user,
    password,
    database,
    connectionTimeoutMillis: 2000,
    max: 1,
  });
  try {
    await probe.query('SELECT 1');
  } catch (error) {
    await probe.end().catch(() => undefined);
    throw new Error(`Postgres at ${host}:${port}/${database} is required for integration tests`, {
      cause: error,
    });
  }
  await probe.end();
  return {
    db: new PostgresDatabase({ host, port, user, password, database, max: 4 }),
    raw: new pg.Pool({ host, port, user, password, database, max: 2 }),
  };
}

const live = required ? await connect() : undefined;

afterAll(async () => {
  await live?.db.close();
  await live?.raw.end();
});

describe.skipIf(!required)('PostgresDatabase against Postgres', () => {
  it('migrate is idempotent and serializes concurrent callers via the advisory lock', async () => {
    await Promise.all([live!.db.migrate(), live!.db.migrate()]);
    await live!.db.ping();
  });

  it('enforces UNIQUE(video_path) and the status CHECK on real inserts', async () => {
    await live!.db.migrate();
    const path = `/it/${Date.now()}-${Math.random()}.mp4`;
    await live!.raw.query(
      `INSERT INTO thumbnails (video_path, thumbnail_key, location, status)
       VALUES ($1, 'k.jpg', '/t/k.jpg', 'failed')`,
      [path],
    );

    await expect(
      live!.raw.query(
        `INSERT INTO thumbnails (video_path, thumbnail_key, location, status)
         VALUES ($1, 'k2.jpg', '/t/k2.jpg', 'completed')`,
        [path],
      ),
    ).rejects.toThrow(/unique|duplicate/i);

    await expect(
      live!.raw.query(
        `INSERT INTO thumbnails (video_path, thumbnail_key, location, status)
         VALUES ($1, 'x.jpg', '/x', 'pending')`,
        [`/it-bad-status/${Date.now()}.mp4`],
      ),
    ).rejects.toThrow(/check constraint|thumbnails_status_check/i);
  });
});
