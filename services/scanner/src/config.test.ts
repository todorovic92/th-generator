import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { loadScannerConfig } from './config.js';
import { ConfigurationError } from '@thumbnail-generator/config';

describe('loadScannerConfig', () => {
  it('applies defaults for one-shot scan', () => {
    const config = loadScannerConfig({});
    expect(config.scanPath).toBe(resolve(process.cwd(), './data/videos'));
    expect(config.thumbnailStoragePath).toBe(resolve(process.cwd(), './data/thumbnails'));
    expect(config.scanIntervalMs).toBe(0);
    expect(config.requeueFailedJobs).toBe(false);
    expect(config.postgres.host).toBe('127.0.0.1');
    expect(config.postgres.database).toBe('thumbnail_generator');
  });

  it('resolves relative paths against INIT_CWD', () => {
    const config = loadScannerConfig({
      INIT_CWD: '/repo',
      VIDEO_SCAN_PATH: './data/videos',
    });
    expect(config.scanPath).toBe(resolve('/repo', './data/videos'));
  });

  it('rejects negative intervals', () => {
    expect(() => loadScannerConfig({ SCAN_INTERVAL_MS: '-1' })).toThrow(ConfigurationError);
  });
});
