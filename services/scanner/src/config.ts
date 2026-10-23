import {
  ConfigurationError,
  parseOneOf,
  parsePostgresConfig,
  parseRedisConfig,
  resolveWorkspacePath,
  type PostgresConfig,
  type RedisConfig,
} from '@thumbnail-generator/config';
import { LOG_LEVEL_NAMES, type LogLevelName } from '@thumbnail-generator/logger';

export interface ScannerConfig {
  redis: RedisConfig;
  logLevel: LogLevelName;
  scanPath: string;
  /** Where generator stores thumbnail objects — used to detect missing files. */
  thumbnailStoragePath: string;
  /** How often to rescan when running as a daemon. 0 = scan once and exit. */
  scanIntervalMs: number;
  /** Re-enqueue BullMQ jobs that exhausted retries. Default false. */
  requeueFailedJobs: boolean;
  /** Used to read durable failure metadata that survives removeOnFail GC. */
  postgres: PostgresConfig;
}

export function loadScannerConfig(env: NodeJS.ProcessEnv = process.env): ScannerConfig {
  const scanPath = resolveWorkspacePath(env.VIDEO_SCAN_PATH ?? './data/videos', env);
  const thumbnailStoragePath = resolveWorkspacePath(
    env.THUMBNAIL_STORAGE_PATH ?? './data/thumbnails',
    env,
  );
  const scanIntervalMs = Number(env.SCAN_INTERVAL_MS ?? '0');

  if (!Number.isFinite(scanIntervalMs) || scanIntervalMs < 0) {
    throw new ConfigurationError('SCAN_INTERVAL_MS must be a non-negative number', {
      value: env.SCAN_INTERVAL_MS,
    });
  }

  return {
    redis: parseRedisConfig(env),
    logLevel: parseOneOf('LOG_LEVEL', env.LOG_LEVEL?.toUpperCase(), LOG_LEVEL_NAMES, 'INFO'),
    scanPath,
    thumbnailStoragePath,
    scanIntervalMs,
    requeueFailedJobs: parseBoolean(env.REQUEUE_FAILED_JOBS, false),
    postgres: parsePostgresConfig(env),
  };
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(value.toLowerCase());
}
