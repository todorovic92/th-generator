import { randomUUID } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { lstat, open, readdir, readFile, rename, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { StorageError } from './errors.js';
import type { IObjectStorage, ObjectStat, PutObjectInput, StoredObject } from './types.js';

/** A single filename; the leading character excludes `.`, `..`, hidden and staging names. */
const VALID_KEY = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,254}$/;
const STAGING_PREFIX = '.tg-staging-';
const DEFAULT_STALE_STAGING_MS = 60 * 60 * 1000;

export interface StagingSweepResult {
  removed: number;
  failed: Array<{ path: string; code: string }>;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException)?.code ?? 'UNKNOWN';
}

export interface LocalObjectStorageOptions {
  /** Root directory where objects are stored. */
  rootDir: string;
}

/**
 * Filesystem-backed object storage.
 *
 * Keys are untrusted; the root directory is trusted (operator-owned). A key must
 * be a single filename (no separators, no leading `.`) and is used verbatim, so
 * `..`, absolute keys, and nested paths cannot place an object outside the root
 * or alias another key. No operation follows a symlink at the leaf:
 * reads use lstat, writes create a fresh staging file with O_EXCL and rename it
 * over the destination, and deletes unlink the entry itself.
 *
 * Not defended: someone with write access to rootDir or its parent can swap the
 * root itself. That actor can already write there directly.
 */
export class LocalObjectStorage implements IObjectStorage {
  private readonly rootDir: string;

  constructor(options: LocalObjectStorageOptions) {
    // Canonicalize so macOS /var → /private/var (and similar) matches returned locations.
    const resolved = resolve(options.rootDir);
    try {
      this.rootDir = realpathSync(resolved);
    } catch {
      this.rootDir = resolved;
    }
  }

  getLocation(key: string): string {
    return this.resolveKeyPath(key);
  }

  async putObject(input: PutObjectInput): Promise<StoredObject> {
    const destination = this.resolveKeyPath(input.key);
    const staging = join(this.rootDir, `${STAGING_PREFIX}${randomUUID()}.tmp`);
    let stagingCreated = false;

    try {
      const data = await readFile(input.sourcePath);
      const handle = await open(staging, 'wx', 0o644);
      stagingCreated = true;
      try {
        await handle.writeFile(data);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, destination);
      stagingCreated = false;

      return { key: input.key, location: destination, size: data.byteLength };
    } catch (error) {
      if (stagingCreated) {
        await unlink(staging).catch(() => undefined);
      }
      throw new StorageError(
        `Failed to store object ${input.key}`,
        { key: input.key, sourcePath: input.sourcePath },
        error,
      );
    }
  }

  async exists(key: string): Promise<boolean> {
    return (await this.statObject(key)) !== null;
  }

  async statObject(key: string): Promise<ObjectStat | null> {
    const location = this.resolveKeyPath(key);
    try {
      const info = await lstat(location);
      if (!info.isFile()) {
        return null;
      }
      return { key, location, size: info.size };
    } catch (error) {
      // Only genuine absence is "missing". EACCES/EMFILE/etc. must not look like missing.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw new StorageError(`Failed to stat object ${key}`, { key }, error);
    }
  }

  async deleteObject(key: string): Promise<void> {
    const location = this.resolveKeyPath(key);
    try {
      await unlink(location);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return;
      }
      throw new StorageError(`Failed to delete object ${key}`, { key }, error);
    }
  }

  /**
   * Remove staging files left by a process killed between open and rename.
   * The age threshold must exceed the longest possible write so a concurrent
   * writer sharing this root never loses its in-flight staging file.
   * Best-effort: never throws; entries it could not remove are reported instead.
   */
  async removeStaleStagingFiles(
    olderThanMs = DEFAULT_STALE_STAGING_MS,
  ): Promise<StagingSweepResult> {
    const cutoff = Date.now() - olderThanMs;
    const result: StagingSweepResult = { removed: 0, failed: [] };

    let names: string[];
    try {
      names = await readdir(this.rootDir);
    } catch (error) {
      result.failed.push({ path: this.rootDir, code: errorCode(error) });
      return result;
    }

    for (const name of names) {
      if (!name.startsWith(STAGING_PREFIX)) {
        continue;
      }
      const path = join(this.rootDir, name);
      try {
        const info = await lstat(path);
        if (info.isFile() && info.mtimeMs < cutoff) {
          await unlink(path);
          result.removed += 1;
        }
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') {
          result.failed.push({ path, code: errorCode(error) });
        }
      }
    }
    return result;
  }

  /**
   * Keys map 1:1 to a single filename directly inside rootDir. Nested keys are
   * rejected rather than flattened, so two distinct keys can never share a file.
   */
  private resolveKeyPath(key: string): string {
    if (!VALID_KEY.test(key)) {
      throw new StorageError('Invalid storage key', { key, rootDir: this.rootDir });
    }
    return join(this.rootDir, key);
  }
}
