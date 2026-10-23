import { describe, it, expect } from 'vitest';
import { isRetryableError } from '@thumbnail-generator/errors';
import { ThumbnailProcessError, VideoNotFoundError } from './errors.js';

describe('generator errors', () => {
  it('marks VideoNotFoundError as non-retryable', () => {
    const err = new VideoNotFoundError('/a/b.mp4');
    expect(err.code).toBe('VIDEO_NOT_FOUND');
    expect(isRetryableError(err)).toBe(false);
  });

  it('marks ThumbnailProcessError as non-retryable by default (corrupt media)', () => {
    const err = new ThumbnailProcessError('ffmpeg failed', {
      exitCode: 1,
      stderr: 'boom',
      videoPath: '/v.mp4',
    });
    expect(err.details?.exitCode).toBe(1);
    expect(isRetryableError(err)).toBe(false);
  });

  it('allows ThumbnailProcessError to be marked retryable for timeouts', () => {
    expect(isRetryableError(new ThumbnailProcessError('timed out', { retryable: true }))).toBe(
      true,
    );
  });
});
