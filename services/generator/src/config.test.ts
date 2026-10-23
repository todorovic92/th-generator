import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadGeneratorConfig } from './config.js';
import { DEFAULT_FFMPEG_TIMEOUT_MS } from './ffmpeg-adapter.js';
import { ConfigurationError } from '@thumbnail-generator/config';

describe('loadGeneratorConfig', () => {
  it('applies defaults with lockDuration above ffmpeg timeout', () => {
    const config = loadGeneratorConfig({});
    expect(config.thumbnailStoragePath).toBe(resolve(process.cwd(), './data/thumbnails'));
    expect(config.workerConcurrency).toBe(2);
    expect(config.ffmpegTimeoutMs).toBe(DEFAULT_FFMPEG_TIMEOUT_MS);
    expect(config.lockDurationMs).toBe(DEFAULT_FFMPEG_TIMEOUT_MS + 60_000);
    expect(config.redis.host).toBe('127.0.0.1');
    expect(config.logLevel).toBe('INFO');
    expect(config.postgres).toMatchObject({
      host: '127.0.0.1',
      port: 5432,
      user: 'postgres',
      database: 'thumbnail_generator',
    });
  });

  it('reads environment overrides including DATABASE_URL', () => {
    const config = loadGeneratorConfig({
      THUMBNAIL_STORAGE_PATH: '/data/thumbs',
      WORKER_CONCURRENCY: '8',
      REDIS_HOST: 'redis',
      REDIS_PORT: '6380',
      LOG_LEVEL: 'debug',
      DATABASE_URL: 'postgres://user:pass@db:5432/thumbs',
      FFMPEG_TIMEOUT_MS: '30000',
      WORKER_LOCK_DURATION_MS: '120000',
    });
    expect(config.thumbnailStoragePath).toBe('/data/thumbs');
    expect(config.workerConcurrency).toBe(8);
    expect(config.redis).toEqual({ host: 'redis', port: 6380 });
    expect(config.logLevel).toBe('DEBUG');
    expect(config.postgres.connectionString).toBe('postgres://user:pass@db:5432/thumbs');
    expect(config.ffmpegTimeoutMs).toBe(30_000);
    expect(config.lockDurationMs).toBe(120_000);
  });

  it('rejects lock duration shorter than ffmpeg timeout + margin', () => {
    expect(() =>
      loadGeneratorConfig({
        FFMPEG_TIMEOUT_MS: '120000',
        WORKER_LOCK_DURATION_MS: '120000',
      }),
    ).toThrow(ConfigurationError);
  });

  it('rejects invalid concurrency', () => {
    expect(() => loadGeneratorConfig({ WORKER_CONCURRENCY: '0' })).toThrow(ConfigurationError);
  });
});
