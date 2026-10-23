import { createLogger } from '@thumbnail-generator/logger';
import { createScannerContainer } from './container.js';

async function main(): Promise<void> {
  const container = await createScannerContainer();
  const { config, logger, scanService } = container;

  let intervalHandle: ReturnType<typeof setInterval> | undefined;
  let inFlight: Promise<void> | undefined;
  let shuttingDown = false;

  const shutdown = async (signal: string) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info('Shutting down scanner', { signal });
    if (intervalHandle) {
      clearInterval(intervalHandle);
      intervalHandle = undefined;
    }
    if (inFlight) {
      await inFlight.catch(() => undefined);
    }
    await container.dispose();
    process.exit(0);
  };

  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));

  process.on('unhandledRejection', (reason) => {
    logger.fatal('Unhandled rejection', {}, reason);
    process.exit(1);
  });

  try {
    if (config.scanIntervalMs === 0) {
      await scanService.runOnce();
      await container.dispose();
      return;
    }

    logger.info('Scanner daemon started', {
      intervalMs: config.scanIntervalMs,
      scanPath: config.scanPath,
    });

    let cycleRunning = false;
    const runGuarded = () => {
      if (shuttingDown) {
        return Promise.resolve();
      }
      if (cycleRunning) {
        logger.warn('Skipping scan cycle — previous scan still in progress');
        return Promise.resolve();
      }
      cycleRunning = true;
      const run = (async () => {
        try {
          await scanService.runOnce();
        } catch (error) {
          logger.error('Periodic scan failed', {}, error);
        } finally {
          cycleRunning = false;
        }
      })();
      inFlight = run;
      return run;
    };

    await runGuarded();
    intervalHandle = setInterval(() => {
      void runGuarded();
    }, config.scanIntervalMs);
  } catch (error) {
    logger.fatal('Scanner failed to start', {}, error);
    await container.dispose();
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  createLogger({ service: 'scanner' }).fatal('Scanner failed to start', {}, error);
  process.exit(1);
});
