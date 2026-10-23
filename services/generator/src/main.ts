import { createLogger } from '@thumbnail-generator/logger';
import { createGeneratorContainer } from './container.js';

async function main(): Promise<void> {
  const container = await createGeneratorContainer();
  const { config, logger } = container;

  logger.info('Thumbnail generator worker started', {
    concurrency: config.workerConcurrency,
    storagePath: config.thumbnailStoragePath,
    redis: `${config.redis.host}:${config.redis.port}`,
  });

  const shutdown = async (signal: string) => {
    logger.info('Shutting down generator', { signal });
    await container.dispose();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal('Unhandled rejection', {}, reason);
    process.exit(1);
  });
}

main().catch((error: unknown) => {
  createLogger({ service: 'generator' }).fatal('Generator failed to start', {}, error);
  process.exit(1);
});
