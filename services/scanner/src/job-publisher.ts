import { createHash } from 'node:crypto';
import type { Queue } from 'bullmq';
import type { ILogger } from '@thumbnail-generator/logger';
import { DEFAULT_JOB_OPTIONS, type ThumbnailJobPayload } from '@thumbnail-generator/queue';
import { PublishLock, PublishLockLostError, type RedisLockClient } from './publish-lock.js';

export { PublishLockLostError } from './publish-lock.js';

export interface IJobPublisher {
  publishThumbnailJobs(videoPaths: string[]): Promise<{ enqueued: number; skipped: number }>;
  close(): Promise<void>;
}

/**
 * Result of checking whether a thumbnail object exists in storage.
 * `unknown` means the check failed — do not requeue or flood.
 */
export type ThumbnailExistence = 'exists' | 'missing' | 'unknown';

/**
 * Durable failure record (e.g. Postgres status=failed), survives removeOnFail GC.
 */
export type PermanentFailureState = 'failed' | 'clear' | 'unknown';

export interface JobPublisherOptions {
  /**
   * When true, exhausted failed jobs are removed and re-queued.
   * Default false — corrupt / missing videos must not loop forever.
   */
  requeueFailed?: boolean;
  /**
   * Whether the thumbnail object for this video is present in storage.
   * Used both when Redis has no job (post-GC) and when the job is completed.
   */
  thumbnailExists?: (videoPath: string) => Promise<ThumbnailExistence>;
  /**
   * Whether metadata says this video permanently failed generation.
   * Required — omitting it fail-closes to `unknown` (no enqueue) so removeOnFail
   * GC cannot re-open the flood door.
   */
  permanentFailureState?: (videoPath: string) => Promise<PermanentFailureState>;
  /** Lock TTL in seconds. Renewed while the critical section runs. */
  publishLockTtlSeconds?: number;
}

const IN_FLIGHT_STATES = new Set(['active', 'waiting', 'delayed', 'paused', 'waiting-children']);
const DEFAULT_PUBLISH_LOCK_TTL_SECONDS = 30;

/**
 * Publishes thumbnail jobs to BullMQ.
 * Uses a per-jobId Redis lock (with renewal) so overlapping scanners cannot race get→remove→add.
 */
export class BullMqJobPublisher implements IJobPublisher {
  private readonly requeueFailed: boolean;
  private readonly thumbnailExists?: (videoPath: string) => Promise<ThumbnailExistence>;
  private readonly permanentFailureState?: (videoPath: string) => Promise<PermanentFailureState>;
  private readonly lock: PublishLock;

  constructor(
    private readonly queue: Queue<ThumbnailJobPayload>,
    private readonly logger: ILogger,
    options: JobPublisherOptions = {},
  ) {
    this.requeueFailed = options.requeueFailed ?? false;
    this.thumbnailExists = options.thumbnailExists;
    this.permanentFailureState = options.permanentFailureState;
    this.lock = new PublishLock(
      () => this.queue.client as Promise<RedisLockClient>,
      options.publishLockTtlSeconds ?? DEFAULT_PUBLISH_LOCK_TTL_SECONDS,
      logger,
    );
  }

  async publishThumbnailJobs(videoPaths: string[]): Promise<{ enqueued: number; skipped: number }> {
    let enqueued = 0;
    let skipped = 0;
    const discoveredAt = new Date().toISOString();

    for (const videoPath of videoPaths) {
      const jobId = jobIdForPath(videoPath);
      const payload: ThumbnailJobPayload = {
        videoPath,
        discoveredAt,
        correlationId: jobId,
      };

      const held = await this.lock.acquire(jobId);
      if (!held) {
        this.logger.debug('Skipping video — another publisher holds the lock', {
          videoPath,
          jobId,
        });
        skipped += 1;
        continue;
      }

      const lockState = { lost: false };
      const stopRenewal = this.lock.startRenewal(jobId, held.token, () => {
        lockState.lost = true;
      });

      try {
        const existing = await this.queue.getJob(jobId);
        if (existing) {
          const state = await existing.getState();

          if (IN_FLIGHT_STATES.has(state)) {
            this.logger.debug('Skipping already-queued video', { videoPath, jobId, state });
            skipped += 1;
            continue;
          }

          if (state === 'completed') {
            const existence = await this.checkExistence(videoPath);
            if (existence !== 'missing') {
              this.logger.debug('Skipping completed job', { videoPath, jobId, existence });
              skipped += 1;
              continue;
            }
            this.logger.info('Re-enqueueing completed job — thumbnail object missing', {
              videoPath,
              jobId,
            });
            await this.lock.assertHeld(jobId, held.token, lockState);
            await existing.remove();
          } else if (state === 'failed') {
            if (!this.requeueFailed) {
              this.logger.debug(
                'Skipping permanently failed job (set REQUEUE_FAILED_JOBS=true to retry)',
                { videoPath, jobId },
              );
              skipped += 1;
              continue;
            }
            await this.lock.assertHeld(jobId, held.token, lockState);
            await existing.remove();
          } else {
            this.logger.warn('Skipping job in unexpected state', { videoPath, jobId, state });
            skipped += 1;
            continue;
          }
        } else {
          // No Redis job (never enqueued, or removeOnComplete / removeOnFail GC'd it).
          const failure = await this.checkPermanentFailure(videoPath);
          if (failure === 'failed' && !this.requeueFailed) {
            this.logger.debug(
              'Skipping enqueue — durable failure record present (survives removeOnFail GC)',
              { videoPath, jobId },
            );
            skipped += 1;
            continue;
          }
          if (failure === 'unknown') {
            this.logger.warn('Skipping enqueue — could not verify durable failure state', {
              videoPath,
              jobId,
            });
            skipped += 1;
            continue;
          }

          const existence = await this.checkExistence(videoPath);
          if (existence === 'exists') {
            this.logger.debug('Skipping enqueue — thumbnail object already present', {
              videoPath,
              jobId,
            });
            skipped += 1;
            continue;
          }
          if (existence === 'unknown') {
            this.logger.warn('Skipping enqueue — could not verify thumbnail existence', {
              videoPath,
              jobId,
            });
            skipped += 1;
            continue;
          }
        }

        await this.enqueueWhileLockHeld(jobId, held.token, lockState, payload);
        enqueued += 1;
        this.logger.info('Enqueued thumbnail job', { videoPath, jobId });
      } catch (error) {
        // Do not abort the whole batch — remaining paths must still be considered.
        this.logger.error('Failed to enqueue thumbnail job', { videoPath, jobId }, error);
        skipped += 1;
      } finally {
        stopRenewal();
        await this.lock.release(jobId, held.token);
      }
    }

    return { enqueued, skipped };
  }

  async close(): Promise<void> {
    await this.queue.close();
  }

  private async checkExistence(videoPath: string): Promise<ThumbnailExistence> {
    if (!this.thumbnailExists) {
      return 'missing';
    }
    return this.thumbnailExists(videoPath);
  }

  private async checkPermanentFailure(videoPath: string): Promise<PermanentFailureState> {
    // Fail closed — without a durable-failure hook, removeOnFail GC would re-flood.
    if (!this.permanentFailureState) {
      return 'unknown';
    }
    return this.permanentFailureState(videoPath);
  }

  /**
   * Renew immediately before add, then verify ownership after add.
   * Do NOT job.remove() on lock loss — another scanner/worker may already own
   * that jobId; deleting it would yank work mid-flight. Leaving the job is safe
   * (deterministic jobId; peers skip in-flight / waiting).
   */
  private async enqueueWhileLockHeld(
    jobId: string,
    token: string,
    lockState: { lost: boolean },
    payload: ThumbnailJobPayload,
  ): Promise<void> {
    await this.lock.assertHeld(jobId, token, lockState);
    await this.queue.add('generate-thumbnail', payload, {
      ...DEFAULT_JOB_OPTIONS,
      jobId,
    });
    const stillHeld = await this.lock.renew(jobId, token);
    if (!stillHeld) {
      lockState.lost = true;
      this.logger.warn(
        'Publish lock lost after enqueue — leaving job in place (will not remove by jobId)',
        { jobId },
      );
      throw new PublishLockLostError(jobId);
    }
  }
}

export function jobIdForPath(videoPath: string): string {
  return createHash('sha256').update(videoPath).digest('hex').slice(0, 32);
}
