import { mkdir } from 'node:fs/promises';
import { createPostgresDatabase, type IDatabase } from '@thumbnail-generator/db';
import { LocalFileSystem } from '@thumbnail-generator/filesystem';
import { createLogger, type ILogger } from '@thumbnail-generator/logger';
import {
  createRedisConnectionOptions,
  type ThumbnailJobPayload,
  type ThumbnailJobResult,
} from '@thumbnail-generator/queue';
import { LocalObjectStorage } from '@thumbnail-generator/storage';
import type { Worker } from 'bullmq';
import { loadGeneratorConfig, type GeneratorConfig } from './config.js';
import { createFfmpegStarter } from './ffmpeg-adapter.js';
import { ThumbnailService } from './thumbnail-service.js';
import type { StartThumbnailProcess } from './thumbnail-process.js';
import { createThumbnailWorker } from './worker.js';
export interface GeneratorContainerOptions {
  env?: NodeJS.ProcessEnv;
  /** Override ffmpeg adapter (useful for tests / demo without ffmpeg). */
  startThumbnailProcess?: StartThumbnailProcess;
  /** Override database (useful for tests). */
  database?: IDatabase;
}

export interface GeneratorContainer {
  config: GeneratorConfig;
  logger: ILogger;
  database: IDatabase;
  thumbnailService: ThumbnailService;
  worker: Worker<ThumbnailJobPayload, ThumbnailJobResult>;
  dispose: () => Promise<void>;
}

/**
 * Composition root for the generator service.
 * Swap LocalObjectStorage for another IObjectStorage implementation here.
 */
export async function createGeneratorContainer(
  options: GeneratorContainerOptions = {},
): Promise<GeneratorContainer> {
  const env = options.env ?? process.env;
  const config = loadGeneratorConfig(env);
  const logger = createLogger({ level: config.logLevel, service: 'generator' });

  await mkdir(config.thumbnailStoragePath, { recursive: true });

  const database =
    options.database ??
    createPostgresDatabase({
      ...(config.postgres.connectionString
        ? { connectionString: config.postgres.connectionString }
        : {
            host: config.postgres.host,
            port: config.postgres.port,
            user: config.postgres.user,
            password: config.postgres.password,
            database: config.postgres.database,
          }),
      logger: logger.child({ component: 'postgres' }),
    });

  await database.migrate();
  await database.ping();
  logger.info('Database ready', {
    host: config.postgres.host,
    database: config.postgres.database,
  });

  const fs = new LocalFileSystem();
  const storage = new LocalObjectStorage({ rootDir: config.thumbnailStoragePath });
  const sweep = await storage.removeStaleStagingFiles();
  if (sweep.removed > 0) {
    logger.info('Removed stale storage staging files', { count: sweep.removed });
  }
  if (sweep.failed.length > 0) {
    logger.warn('Could not remove some stale storage staging files; continuing', {
      failed: sweep.failed,
    });
  }

  const thumbnailService = new ThumbnailService({
    fs,
    storage,
    thumbnails: database.thumbnails,
    startThumbnailProcess:
      options.startThumbnailProcess ?? createFfmpegStarter({ timeoutMs: config.ffmpegTimeoutMs }),
    logger: logger.child({ component: 'thumbnail-service' }),
  });

  const worker = createThumbnailWorker(thumbnailService, logger.child({ component: 'worker' }), {
    connection: createRedisConnectionOptions(config.redis),
    concurrency: config.workerConcurrency,
    lockDurationMs: config.lockDurationMs,
  });

  return {
    config,
    logger,
    database,
    thumbnailService,
    worker,
    dispose: async () => {
      await worker.close();
      await database.close();
    },
  };
}
