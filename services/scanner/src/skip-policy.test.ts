import { describe, it, expect, vi } from 'vitest';
import type { ILogger } from '@thumbnail-generator/logger';
import { StorageError } from '@thumbnail-generator/storage';
import { createPermanentFailureCheck, createThumbnailExistsCheck } from './skip-policy.js';

function createLoggerMock(): ILogger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(function (this: ILogger) {
      return this;
    }),
    setLevel: vi.fn(),
  };
}

describe('createThumbnailExistsCheck', () => {
  it('maps exists / missing and fail-closes to unknown', async () => {
    const logger = createLoggerMock();
    const exists = vi.fn();
    const check = createThumbnailExistsCheck(
      {
        exists,
        putObject: vi.fn(),
        statObject: vi.fn(),
        deleteObject: vi.fn(),
        getLocation: vi.fn(),
      },
      logger,
    );

    exists.mockResolvedValueOnce(true);
    await expect(check('/v.mp4')).resolves.toBe('exists');
    exists.mockResolvedValueOnce(false);
    await expect(check('/v.mp4')).resolves.toBe('missing');
    exists.mockRejectedValueOnce(new StorageError('EACCES'));
    await expect(check('/v.mp4')).resolves.toBe('unknown');
    expect(logger.warn).toHaveBeenCalled();
  });
});

describe('createPermanentFailureCheck', () => {
  it('returns failed / clear / unknown', async () => {
    const logger = createLoggerMock();
    const findByVideoPath = vi.fn();
    const check = createPermanentFailureCheck(
      { findByVideoPath, upsert: vi.fn() } as never,
      logger,
    );

    findByVideoPath.mockResolvedValueOnce({ status: 'failed' });
    await expect(check('/v.mp4')).resolves.toBe('failed');
    findByVideoPath.mockResolvedValueOnce({ status: 'completed' });
    await expect(check('/v.mp4')).resolves.toBe('clear');
    findByVideoPath.mockResolvedValueOnce(null);
    await expect(check('/v.mp4')).resolves.toBe('clear');
    findByVideoPath.mockRejectedValueOnce(new Error('db down'));
    await expect(check('/v.mp4')).resolves.toBe('unknown');
  });
});
