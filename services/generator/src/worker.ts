import { UnrecoverableError, Worker, type Job, type WorkerOptions } from 'bullmq';
import type { ILogger } from '@thumbnail-generator/logger';
import { isRetryableError } from '@thumbnail-generator/errors';
import {
  THUMBNAIL_QUEUE_NAME,
  type ThumbnailJobPayload,
  type ThumbnailJobResult,
} from '@thumbnail-generator/queue';
import { DEFAULT_FFMPEG_TIMEOUT_MS } from './ffmpeg-adapter.js';
import type { ThumbnailService } from './thumbnail-service.js';

/** Matches loadGeneratorConfig default: ffmpeg budget + margin. */
export const DEFAULT_WORKER_LOCK_DURATION_MS = DEFAULT_FFMPEG_TIMEOUT_MS + 60_000;

export interface ThumbnailWorkerOptions {
  connection: WorkerOptions['connection'];
  /** Parallel jobs per process. Scale out with more replicas × concurrency. */
  concurrency: number;
  /** Max time allowed for a single job (ffmpeg can be slow on large files). */
  lockDurationMs?: number;
}

/**
 * Permanent failures must not burn remaining BullMQ attempts. Keep the original
 * error as `.cause` so ffmpeg stderr / AppError details reach the failed-job record.
 */
export function rethrowForQueue(error: unknown): never {
  if (isRetryableError(error)) {
    throw error;
  }
  const message = error instanceof Error ? error.message : String(error);
  const wrapped = new UnrecoverableError(message);
  Object.assign(wrapped, { cause: error });
  throw wrapped;
}

/**
 * BullMQ worker that delegates to ThumbnailService.
 * Horizontal scaling: run multiple generator processes against the same Redis queue.
 */
export function createThumbnailWorker(
  thumbnailService: ThumbnailService,
  logger: ILogger,
  options: ThumbnailWorkerOptions,
): Worker<ThumbnailJobPayload, ThumbnailJobResult> {
  const worker = new Worker<ThumbnailJobPayload, ThumbnailJobResult>(
    THUMBNAIL_QUEUE_NAME,
    async (job: Job<ThumbnailJobPayload>) => {
      const jobLogger = logger.child({
        jobId: job.id,
        attempt: job.attemptsMade + 1,
        correlationId: job.data.correlationId,
      });

      jobLogger.info('Processing thumbnail job', { videoPath: job.data.videoPath });

      try {
        return await thumbnailService.generate(job.data);
      } catch (error) {
        const retryable = isRetryableError(error);
        jobLogger.error(
          'Thumbnail job failed',
          { retryable, videoPath: job.data.videoPath },
          error,
        );
        rethrowForQueue(error);
      }
    },
    {
      connection: options.connection,
      concurrency: options.concurrency,
      lockDuration: options.lockDurationMs ?? DEFAULT_WORKER_LOCK_DURATION_MS,
    },
  );

  worker.on('completed', (job) => {
    logger.info('Job completed', { jobId: job.id, videoPath: job.data.videoPath });
  });

  worker.on('failed', (job, error) => {
    logger.error(
      'Job failed permanently or will retry',
      { jobId: job?.id, videoPath: job?.data.videoPath },
      error,
    );
  });

  worker.on('error', (error) => {
    logger.error('Worker error', {}, error);
  });

  return worker;
}
