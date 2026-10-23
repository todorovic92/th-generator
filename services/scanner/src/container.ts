import { createPostgresDatabase } from '@thumbnail-generator/db';
import { Queue } from 'bullmq';
import { LocalFileSystem, VideoScanner } from '@thumbnail-generator/filesystem';
import { createLogger, type ILogger } from '@thumbnail-generator/logger';
import {
  THUMBNAIL_QUEUE_NAME,
  createRedisConnectionOptions,
  type ThumbnailJobPayload,
} from '@thumbnail-generator/queue';
import { LocalObjectStorage } from '@thumbnail-generator/storage';
import { loadScannerConfig, type ScannerConfig } from './config.js';
import { BullMqJobPublisher, type IJobPublisher } from './job-publisher.js';
import { ScanService } from './scan-service.js';
import { createPermanentFailureCheck, createThumbnailExistsCheck } from './skip-policy.js';

/**
 * Composition root — the only place that wires concrete implementations.
 * Prefer this over a heavy DI container: explicit, typed, and trivial to test
 * by constructing ScanService with mocks directly.
 */
export interface ScannerContainer {
  config: ScannerConfig;
  logger: ILogger;
  scanService: ScanService;
  publisher: IJobPublisher;
  dispose: () => Promise<void>;
}

export async function createScannerContainer(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ScannerContainer> {
  const config = loadScannerConfig(env);
  const logger = createLogger({ level: config.logLevel, service: 'scanner' });

  const fs = new LocalFileSystem();
  const walkLogger = logger.child({ component: 'video-scanner' });
  const videoScanner = new VideoScanner(fs, {
    onSkip: (path, reason, error) =>
      walkLogger.warn('Skipping path during scan', {
        path,
        reason,
        ...(error ? { error: String(error) } : {}),
      }),
  });
  const storage = new LocalObjectStorage({ rootDir: config.thumbnailStoragePath });

  const database = createPostgresDatabase({
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

  // Migrate here so durable-failure lookups work even if the generator has not started yet.
  await database.migrate();
  await database.ping();
  logger.info('Database ready', {
    host: config.postgres.host,
    database: config.postgres.database,
  });

  const queue = new Queue<ThumbnailJobPayload>(THUMBNAIL_QUEUE_NAME, {
    connection: createRedisConnectionOptions(config.redis),
  });

  const skipLogger = logger.child({ component: 'skip-policy' });
  const publisher = new BullMqJobPublisher(queue, logger.child({ component: 'publisher' }), {
    requeueFailed: config.requeueFailedJobs,
    thumbnailExists: createThumbnailExistsCheck(storage, skipLogger),
    permanentFailureState: createPermanentFailureCheck(database.thumbnails, skipLogger),
  });
  const scanService = new ScanService(
    videoScanner,
    publisher,
    logger.child({ component: 'scan-service' }),
    config.scanPath,
  );

  return {
    config,
    logger,
    scanService,
    publisher,
    dispose: async () => {
      await publisher.close();
      await database.close();
    },
  };
}
