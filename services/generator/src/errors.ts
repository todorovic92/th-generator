import { AppError } from '@thumbnail-generator/errors';

export class VideoNotFoundError extends AppError {
  constructor(path: string) {
    super(`Video not found: ${path}`, {
      code: 'VIDEO_NOT_FOUND',
      retryable: false,
      details: { path },
    });
  }
}

/**
 * ffmpeg / thumbnail process failures.
 * Default is non-retryable — corrupt media should not burn BullMQ attempts.
 * Callers must set retryable: true for transient failures (timeouts, spawn crashes).
 */
export class ThumbnailProcessError extends AppError {
  constructor(
    message: string,
    options: {
      exitCode?: number;
      stderr?: string;
      videoPath?: string;
      cause?: unknown;
      retryable?: boolean;
    } = {},
  ) {
    super(message, {
      code: 'THUMBNAIL_PROCESS_ERROR',
      retryable: options.retryable ?? false,
      details: {
        exitCode: options.exitCode,
        stderr: options.stderr,
        videoPath: options.videoPath,
      },
      cause: options.cause,
    });
  }
}
