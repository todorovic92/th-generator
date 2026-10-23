import { readdir, stat, realpath } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { FileSystemError, PathNotFoundError } from './errors.js';
import type { FileInfo, IFileSystem } from './types.js';

const NOT_FOUND_CODES = new Set(['ENOENT', 'ENOTDIR']);

function toFileSystemError(message: string, path: string, error: unknown): FileSystemError {
  if (NOT_FOUND_CODES.has((error as NodeJS.ErrnoException)?.code ?? '')) {
    return new PathNotFoundError(path, error);
  }
  return new FileSystemError(message, { path }, error);
}

/**
 * Local POSIX filesystem adapter.
 * In production this can be swapped for a remote FS without changing callers.
 * Only ENOENT / ENOTDIR mean "missing"; every other failure is a retryable FileSystemError.
 */
export class LocalFileSystem implements IFileSystem {
  async listFiles(path: string): Promise<string[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => join(path, entry.name));
    } catch (error) {
      throw toFileSystemError(`Failed to list files at ${path}`, path, error);
    }
  }

  async openFile(path: string): Promise<FileInfo> {
    let stats;
    try {
      stats = await stat(path);
    } catch (error) {
      throw toFileSystemError(`Failed to open file ${path}`, path, error);
    }

    let realPath: string | undefined;
    try {
      realPath = await realpath(path);
    } catch {
      // stat succeeded, so this is a race or an odd mount; callers treat it as unverifiable
    }

    return {
      name: basename(path),
      path,
      permissions: stats.mode,
      size: stats.size,
      isDirectory: stats.isDirectory(),
      modifiedAt: stats.mtime,
      identity: realPath ?? `${stats.dev}:${stats.ino}`,
      ...(realPath ? { realPath } : {}),
    };
  }

  async exists(path: string): Promise<boolean> {
    try {
      await stat(path);
      return true;
    } catch (error) {
      const wrapped = toFileSystemError(`Failed to check existence of ${path}`, path, error);
      if (wrapped instanceof PathNotFoundError) {
        return false;
      }
      throw wrapped;
    }
  }
}
