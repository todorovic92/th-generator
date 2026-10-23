import { describe, it, expect } from 'vitest';
import { UnrecoverableError } from 'bullmq';
import { AppError } from '@thumbnail-generator/errors';
import { rethrowForQueue } from './worker.js';
import { ThumbnailProcessError, VideoNotFoundError } from './errors.js';

describe('rethrowForQueue', () => {
  it('rethrows retryable errors unchanged', () => {
    const error = new AppError('blip', { code: 'X', retryable: true });
    expect(() => rethrowForQueue(error)).toThrow(error);
  });

  it('wraps a permanent failure as UnrecoverableError and keeps the original as cause', () => {
    const cause = new ThumbnailProcessError('ffmpeg failed', {
      stderr: 'Invalid data found',
      videoPath: '/v.mp4',
    });
    const thrown = catchThrown(() => rethrowForQueue(cause));
    expect(thrown).toBeInstanceOf(UnrecoverableError);
    expect((thrown as Error).cause).toBe(cause);
    expect((thrown as Error).message).toBe('ffmpeg failed');
  });

  it('keeps VideoNotFoundError as cause', () => {
    const cause = new VideoNotFoundError('/missing.mp4');
    const thrown = catchThrown(() => rethrowForQueue(cause));
    expect((thrown as Error).cause).toBe(cause);
  });
});

function catchThrown(fn: () => never): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error('expected throw');
}
