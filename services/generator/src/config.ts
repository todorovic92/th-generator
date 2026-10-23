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
import { DEFAULT_FFMPEG_TIMEOUT_MS } from './ffmpeg-adapter.js';

/** Extra headroom above ffmpeg budget for kill grace + Redis lock renewal jitter. */
const LOCK_MARGIN_MS = 60_000;

export interface GeneratorConfig {
  redis: RedisConfig;
  logLevel: LogLevelName;
  thumbnailStoragePath: string;
  workerConcurrency: number;
  lockDurationMs: number;
  /** Shared wall-clock budget for all ffmpeg seek attempts in one job. */
  ffmpegTimeoutMs: number;
  postgres: PostgresConfig;
}

export function loadGeneratorConfig(env: NodeJS.ProcessEnv = process.env): GeneratorConfig {
  const thumbnailStoragePath = resolveWorkspacePath(
    env.THUMBNAIL_STORAGE_PATH ?? './data/thumbnails',
    env,
  );
  const workerConcurrency = Number(env.WORKER_CONCURRENCY ?? '2');
  const ffmpegTimeoutMs = Number(env.FFMPEG_TIMEOUT_MS ?? String(DEFAULT_FFMPEG_TIMEOUT_MS));
  const defaultLock = ffmpegTimeoutMs + LOCK_MARGIN_MS;
  const lockDurationMs = Number(env.WORKER_LOCK_DURATION_MS ?? String(defaultLock));

  if (!Number.isInteger(workerConcurrency) || workerConcurrency < 1) {
    throw new ConfigurationError('WORKER_CONCURRENCY must be a positive integer', {
      value: env.WORKER_CONCURRENCY,
    });
  }

  if (!Number.isInteger(ffmpegTimeoutMs) || ffmpegTimeoutMs < 1000) {
    throw new ConfigurationError('FFMPEG_TIMEOUT_MS must be >= 1000', {
      value: env.FFMPEG_TIMEOUT_MS,
    });
  }

  if (!Number.isInteger(lockDurationMs) || lockDurationMs < 1000) {
    throw new ConfigurationError('WORKER_LOCK_DURATION_MS must be >= 1000', {
      value: env.WORKER_LOCK_DURATION_MS,
    });
  }

  if (lockDurationMs < ffmpegTimeoutMs + LOCK_MARGIN_MS) {
    throw new ConfigurationError(
      `WORKER_LOCK_DURATION_MS (${lockDurationMs}) must be >= FFMPEG_TIMEOUT_MS + ${LOCK_MARGIN_MS} (${ffmpegTimeoutMs + LOCK_MARGIN_MS}) to avoid lock theft during ffmpeg`,
      { lockDurationMs, ffmpegTimeoutMs, marginMs: LOCK_MARGIN_MS },
    );
  }

  return {
    redis: parseRedisConfig(env),
    logLevel: parseOneOf('LOG_LEVEL', env.LOG_LEVEL?.toUpperCase(), LOG_LEVEL_NAMES, 'INFO'),
    thumbnailStoragePath,
    workerConcurrency,
    lockDurationMs,
    ffmpegTimeoutMs,
    postgres: parsePostgresConfig(env),
  };
}
