import type { IThumbnailRepository } from '@thumbnail-generator/db';
import type { ILogger } from '@thumbnail-generator/logger';
import { buildThumbnailKey, type IObjectStorage } from '@thumbnail-generator/storage';
import type { PermanentFailureState, ThumbnailExistence } from './job-publisher.js';

export function createThumbnailExistsCheck(
  storage: IObjectStorage,
  logger: ILogger,
): (videoPath: string) => Promise<ThumbnailExistence> {
  return async (videoPath) => {
    const key = buildThumbnailKey(videoPath);
    try {
      return (await storage.exists(key)) ? 'exists' : 'missing';
    } catch (error) {
      logger.warn('Thumbnail existence check failed', {
        videoPath,
        key,
        error: String(error),
      });
      return 'unknown';
    }
  };
}

export function createPermanentFailureCheck(
  thumbnails: IThumbnailRepository,
  logger: ILogger,
): (videoPath: string) => Promise<PermanentFailureState> {
  return async (videoPath) => {
    try {
      const record = await thumbnails.findByVideoPath(videoPath);
      return record?.status === 'failed' ? 'failed' : 'clear';
    } catch (error) {
      logger.warn('Durable failure lookup failed', {
        videoPath,
        error: String(error),
      });
      return 'unknown';
    }
  };
}
