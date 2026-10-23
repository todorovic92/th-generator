import { AppError } from '@thumbnail-generator/errors';

/** Transient by default: permissions, fd exhaustion, flaky mounts. */
export class FileSystemError extends AppError {
  constructor(
    message: string,
    details?: Record<string, unknown>,
    cause?: unknown,
    options: { code?: string; retryable?: boolean } = {},
  ) {
    super(message, {
      code: options.code ?? 'FILESYSTEM_ERROR',
      retryable: options.retryable ?? true,
      details,
      cause,
    });
  }
}

/**
 * The path definitively does not exist. Adapters must throw this only for a
 * genuine absence (ENOENT / ENOTDIR locally), never for errors that could clear up.
 */
export class PathNotFoundError extends FileSystemError {
  constructor(path: string, cause?: unknown) {
    super(`Path not found: ${path}`, { path }, cause, {
      code: 'PATH_NOT_FOUND',
      retryable: false,
    });
  }
}
