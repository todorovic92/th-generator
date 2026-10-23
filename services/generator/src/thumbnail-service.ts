import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { IThumbnailRepository } from '@thumbnail-generator/db';
import {
  PathNotFoundError,
  type FileInfo,
  type IFileSystem,
} from '@thumbnail-generator/filesystem';
import type { ILogger } from '@thumbnail-generator/logger';
import type { IObjectStorage } from '@thumbnail-generator/storage';
import { buildThumbnailKey } from '@thumbnail-generator/storage';
import type { ThumbnailJobPayload, ThumbnailJobResult } from '@thumbnail-generator/queue';
import { ThumbnailProcessError, VideoNotFoundError } from './errors.js';
import {
  isRetryableProcessFailure,
  isRetryableStorageOrDbFailure,
  isTransientFfmpegFailure,
} from './ffmpeg-failure.js';
import type { StartThumbnailProcess } from './thumbnail-process.js';

export interface ThumbnailServiceDeps {
  fs: IFileSystem;
  storage: IObjectStorage;
  thumbnails: IThumbnailRepository;
  startThumbnailProcess: StartThumbnailProcess;
  logger: ILogger;
  /** Temp directory root for intermediate ffmpeg output. */
  tempDirRoot?: string;
}

/**
 * Core thumbnail generation use-case.
 * Isolates ffmpeg + storage + metadata persistence so the worker stays thin.
 */
export class ThumbnailService {
  private readonly fs: IFileSystem;
  private readonly storage: IObjectStorage;
  private readonly thumbnails: IThumbnailRepository;
  private readonly startThumbnailProcess: StartThumbnailProcess;
  private readonly logger: ILogger;
  private readonly tempDirRoot: string;

  constructor(deps: ThumbnailServiceDeps) {
    this.fs = deps.fs;
    this.storage = deps.storage;
    this.thumbnails = deps.thumbnails;
    this.startThumbnailProcess = deps.startThumbnailProcess;
    this.logger = deps.logger;
    this.tempDirRoot = deps.tempDirRoot ?? tmpdir();
  }

  async generate(payload: ThumbnailJobPayload): Promise<ThumbnailJobResult> {
    const started = Date.now();
    const { videoPath, correlationId } = payload;
    const log = this.logger.child({
      videoPath,
      correlationId,
    });

    log.info('Starting thumbnail generation');

    const existingMeta = await this.thumbnails.findByVideoPath(videoPath);
    if (existingMeta?.status === 'completed') {
      const objectStillThere = await this.storage.exists(existingMeta.thumbnailKey);
      if (objectStillThere) {
        log.info('Thumbnail metadata and object already present, skipping generation', {
          thumbnailKey: existingMeta.thumbnailKey,
          recordId: existingMeta.id,
        });
        return {
          videoPath,
          thumbnailKey: existingMeta.thumbnailKey,
          durationMs: Date.now() - started,
        };
      }
      log.warn('Completed metadata found but object missing — regenerating', {
        thumbnailKey: existingMeta.thumbnailKey,
        recordId: existingMeta.id,
      });
    }

    const thumbnailKey = buildThumbnailKey(videoPath);

    // Only a definitive absence is permanent; EACCES / EMFILE / flaky mounts propagate as retryable.
    let info: FileInfo;
    try {
      info = await this.fs.openFile(videoPath);
    } catch (error) {
      if (error instanceof PathNotFoundError) {
        return this.failPermanent(
          videoPath,
          thumbnailKey,
          correlationId,
          0,
          new VideoNotFoundError(videoPath),
        );
      }
      throw error;
    }
    if (info.isDirectory) {
      await this.failPermanent(
        videoPath,
        thumbnailKey,
        correlationId,
        info.size,
        new VideoNotFoundError(videoPath),
      );
    }

    const existingObject = await this.storage.statObject(thumbnailKey);
    if (existingObject) {
      log.info('Thumbnail object already exists, ensuring metadata', { thumbnailKey });
      await this.thumbnails.upsert({
        videoPath,
        thumbnailKey,
        location: existingObject.location,
        sizeBytes: existingObject.size,
        status: 'completed',
        ...(correlationId ? { correlationId } : {}),
        durationMs: Date.now() - started,
        videoSizeBytes: info.size,
      });
      return {
        videoPath,
        thumbnailKey,
        durationMs: Date.now() - started,
      };
    }

    const workDir = await mkdtemp(join(this.tempDirRoot, 'tg-thumb-'));
    const tempOutput = join(workDir, 'thumbnail.jpg');

    try {
      const processHandle = this.startThumbnailProcess(videoPath, tempOutput);
      log.debug('ffmpeg process started');

      let exitCode: number;
      try {
        exitCode = await processHandle.waitForCompletion();
      } catch (error) {
        await processHandle.kill().catch(() => undefined);
        const retryable = isRetryableProcessFailure(error);
        if (!retryable) {
          await this.failPermanent(
            videoPath,
            thumbnailKey,
            correlationId,
            info.size,
            error,
            'Thumbnail process failed to start, crashed, or timed out',
          );
        }
        throw new ThumbnailProcessError(
          'Thumbnail process failed to start, crashed, or timed out',
          {
            videoPath,
            cause: error,
            retryable: true,
          },
        );
      }

      if (exitCode !== 0) {
        const stderr = processHandle.getStderr();
        const retryable = isTransientFfmpegFailure(stderr, exitCode);
        log.error('ffmpeg exited with non-zero status', { exitCode, stderr, retryable });
        if (!retryable) {
          await this.failPermanent(
            videoPath,
            thumbnailKey,
            correlationId,
            info.size,
            new Error(stderr || `exit ${exitCode}`),
            `ffmpeg exited with code ${exitCode}`,
            { exitCode, stderr },
          );
        }
        throw new ThumbnailProcessError(`ffmpeg exited with code ${exitCode}`, {
          exitCode,
          stderr,
          videoPath,
          retryable: true,
        });
      }

      let stored;
      try {
        stored = await this.storage.putObject({
          key: thumbnailKey,
          sourcePath: tempOutput,
          contentType: 'image/jpeg',
        });
      } catch (error) {
        const retryable = isRetryableStorageOrDbFailure(error);
        if (!retryable) {
          await this.failPermanent(
            videoPath,
            thumbnailKey,
            correlationId,
            info.size,
            error,
            'Failed to store thumbnail object',
          );
        }
        throw new ThumbnailProcessError('Failed to store thumbnail object', {
          videoPath,
          cause: error,
          retryable: true,
        });
      }

      const durationMs = Date.now() - started;
      let record;
      try {
        record = await this.thumbnails.upsert({
          videoPath,
          thumbnailKey: stored.key,
          location: stored.location,
          sizeBytes: stored.size,
          contentType: 'image/jpeg',
          status: 'completed',
          ...(correlationId ? { correlationId } : {}),
          durationMs,
          videoSizeBytes: info.size,
        });
      } catch (error) {
        // Object is already stored — retry so metadata can catch up. Do not mark failed.
        throw new ThumbnailProcessError('Failed to persist completed thumbnail metadata', {
          videoPath,
          cause: error,
          retryable: true,
        });
      }

      const result: ThumbnailJobResult = {
        videoPath,
        thumbnailKey: stored.key,
        durationMs,
      };

      log.info('Thumbnail generation complete', {
        thumbnailKey: result.thumbnailKey,
        location: stored.location,
        durationMs: result.durationMs,
        size: stored.size,
        recordId: record.id,
      });

      return result;
    } finally {
      await rm(workDir, { recursive: true, force: true }).catch((error) => {
        log.warn('Failed to clean up temp directory', { workDir, error: String(error) });
      });
    }
  }

  /**
   * Persist durable `failed` then throw. If upsert itself fails, throw retryable so
   * BullMQ does not UnrecoverableError + removeOnFail without a DB row (flood door).
   */
  private async failPermanent(
    videoPath: string,
    thumbnailKey: string,
    correlationId: string | undefined,
    videoSizeBytes: number,
    error: unknown,
    processMessage?: string,
    processDetails?: { exitCode?: number; stderr?: string },
  ): Promise<never> {
    const persisted = await this.recordFailure(
      videoPath,
      thumbnailKey,
      correlationId,
      videoSizeBytes,
      error,
    );

    if (!persisted) {
      throw new ThumbnailProcessError(
        processMessage ??
          (error instanceof Error ? error.message : 'Permanent failure (metadata not persisted)'),
        {
          videoPath,
          cause: error,
          retryable: true,
          ...processDetails,
        },
      );
    }

    if (error instanceof VideoNotFoundError) {
      throw error;
    }

    throw new ThumbnailProcessError(
      processMessage ?? (error instanceof Error ? error.message : 'Permanent thumbnail failure'),
      {
        videoPath,
        cause: error,
        retryable: false,
        ...processDetails,
      },
    );
  }

  /** @returns true when the durable failed row was written. */
  private async recordFailure(
    videoPath: string,
    thumbnailKey: string,
    correlationId: string | undefined,
    videoSizeBytes: number,
    error: unknown,
  ): Promise<boolean> {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await this.thumbnails.upsert({
        videoPath,
        thumbnailKey,
        location: this.storage.getLocation(thumbnailKey),
        sizeBytes: 0,
        status: 'failed',
        ...(correlationId ? { correlationId } : {}),
        videoSizeBytes,
        errorMessage: message.slice(0, 2000),
      });
      return true;
    } catch (persistError) {
      this.logger.warn('Failed to persist failure metadata', {
        videoPath,
        error: String(persistError),
      });
      return false;
    }
  }
}
