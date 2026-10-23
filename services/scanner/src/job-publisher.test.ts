import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BullMqJobPublisher, jobIdForPath } from './job-publisher.js';
import type { ILogger } from '@thumbnail-generator/logger';

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

const clearFailure = async () => 'clear' as const;

describe('BullMqJobPublisher', () => {
  let locks: Map<string, string>;
  let redis: {
    set: ReturnType<typeof vi.fn>;
    get: ReturnType<typeof vi.fn>;
    eval: ReturnType<typeof vi.fn>;
  };
  let queue: {
    getJob: ReturnType<typeof vi.fn>;
    add: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
    client: Promise<typeof redis>;
  };
  let logger: ILogger;

  beforeEach(() => {
    locks = new Map();
    redis = {
      set: vi.fn().mockImplementation(async (key: string, token: string) => {
        if (locks.has(key)) {
          return null;
        }
        locks.set(key, token);
        return 'OK';
      }),
      get: vi.fn().mockImplementation(async (key: string) => locks.get(key) ?? null),
      eval: vi
        .fn()
        .mockImplementation(async (script: string, _n: number, key: string, token: string) => {
          if (String(script).includes('del')) {
            if (locks.get(key) === token) {
              locks.delete(key);
              return 1;
            }
            return 0;
          }
          if (String(script).includes('expire')) {
            return locks.get(key) === token ? 1 : 0;
          }
          return 1;
        }),
    };
    queue = {
      getJob: vi.fn().mockResolvedValue(undefined),
      add: vi.fn().mockResolvedValue({}),
      close: vi.fn(),
      client: Promise.resolve(redis),
    };
    logger = createLoggerMock();
  });

  it('enqueues jobs with deterministic ids when object is missing', async () => {
    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => 'missing',
      permanentFailureState: clearFailure,
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 1, skipped: 0 });
    expect(queue.add).toHaveBeenCalledWith(
      'generate-thumbnail',
      expect.objectContaining({ videoPath: '/videos/a.mp4' }),
      expect.objectContaining({ jobId: jobIdForPath('/videos/a.mp4') }),
    );
  });

  it('does not re-flood the queue when Redis job is gone but object exists', async () => {
    queue.getJob.mockResolvedValue(undefined);
    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => 'exists',
      permanentFailureState: clearFailure,
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it("skips enqueue when Redis job was GC'd but durable failure remains", async () => {
    queue.getJob.mockResolvedValue(undefined);
    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => 'missing',
      permanentFailureState: async () => 'failed',
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips enqueue when durable failure lookup is unknown', async () => {
    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => 'missing',
      permanentFailureState: async () => 'unknown',
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('fail-closes when permanentFailureState hook is omitted', async () => {
    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => 'missing',
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips enqueue when existence check is unknown', async () => {
    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => 'unknown',
      permanentFailureState: clearFailure,
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips when publish lock is held by another scanner', async () => {
    redis.set.mockResolvedValue(null);
    const publisher = new BullMqJobPublisher(queue as never, logger, {
      permanentFailureState: clearFailure,
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(queue.getJob).not.toHaveBeenCalled();
  });

  it('skips videos that are already waiting', async () => {
    queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('waiting'),
      remove: vi.fn(),
    });

    const publisher = new BullMqJobPublisher(queue as never, logger, {
      permanentFailureState: clearFailure,
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('skips completed jobs when object exists or check is unknown', async () => {
    queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'),
      remove: vi.fn(),
    });

    for (const existence of ['exists', 'unknown'] as const) {
      queue.add.mockClear();
      locks.clear();
      const publisher = new BullMqJobPublisher(queue as never, logger, {
        thumbnailExists: async () => existence,
        permanentFailureState: clearFailure,
      });
      const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);
      expect(result).toEqual({ enqueued: 0, skipped: 1 });
      expect(queue.add).not.toHaveBeenCalled();
    }
  });

  it('re-enqueues completed jobs when thumbnail object is missing', async () => {
    const remove = vi.fn();
    queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'),
      remove,
    });

    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => 'missing',
      permanentFailureState: clearFailure,
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(remove).toHaveBeenCalled();
    expect(result.enqueued).toBe(1);
  });

  it('skips remove/add when Redis lock token no longer matches', async () => {
    const remove = vi.fn();
    queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('completed'),
      remove,
    });

    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => {
        // Simulate TTL expiry between renew ticks: wipe the lock key.
        locks.clear();
        return 'missing';
      },
      permanentFailureState: clearFailure,
      publishLockTtlSeconds: 30,
    });

    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(remove).not.toHaveBeenCalled();
    expect(queue.add).not.toHaveBeenCalled();
  });

  it('leaves the job in place if lock is lost during queue.add', async () => {
    const addedRemove = vi.fn().mockResolvedValue(undefined);
    queue.getJob.mockResolvedValue(undefined);
    queue.add.mockImplementation(async () => {
      locks.clear(); // TTL expired during BullMQ add
      return {};
    });

    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => 'missing',
      permanentFailureState: clearFailure,
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(result).toEqual({ enqueued: 0, skipped: 1 });
    expect(queue.add).toHaveBeenCalledOnce();
    // Must not yank a jobId another scanner/worker may already own.
    expect(addedRemove).not.toHaveBeenCalled();
    expect(queue.getJob).toHaveBeenCalledTimes(1);
  });

  it('continues the batch when one path fails to enqueue', async () => {
    queue.add.mockRejectedValueOnce(new Error('redis blip')).mockResolvedValueOnce({});

    const publisher = new BullMqJobPublisher(queue as never, logger, {
      thumbnailExists: async () => 'missing',
      permanentFailureState: clearFailure,
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4', '/videos/b.mp4']);

    expect(result).toEqual({ enqueued: 1, skipped: 1 });
    expect(queue.add).toHaveBeenCalledTimes(2);
  });

  it('does not re-enqueue failed jobs by default', async () => {
    const remove = vi.fn();
    queue.getJob.mockResolvedValue({
      getState: vi.fn().mockResolvedValue('failed'),
      remove,
    });

    const publisher = new BullMqJobPublisher(queue as never, logger, {
      permanentFailureState: clearFailure,
    });
    const result = await publisher.publishThumbnailJobs(['/videos/a.mp4']);

    expect(remove).not.toHaveBeenCalled();
    expect(result).toEqual({ enqueued: 0, skipped: 1 });
  });

  it('jobIdForPath is stable and path-specific', () => {
    expect(jobIdForPath('/a.mp4')).toBe(jobIdForPath('/a.mp4'));
    expect(jobIdForPath('/a.mp4')).not.toBe(jobIdForPath('/b.mp4'));
  });
});
