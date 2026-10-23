import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ScanService } from './scan-service.js';
import type { IJobPublisher } from './job-publisher.js';
import type { IVideoScanner } from '@thumbnail-generator/filesystem';
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

describe('ScanService', () => {
  let videoScanner: IVideoScanner;
  let publisher: IJobPublisher;
  let logger: ILogger;

  beforeEach(() => {
    videoScanner = {
      findVideos: vi.fn().mockResolvedValue(['/v/a.mp4', '/v/b.mkv']),
    };
    publisher = {
      publishThumbnailJobs: vi.fn().mockResolvedValue({ enqueued: 2, skipped: 0 }),
      close: vi.fn(),
    };
    logger = createLoggerMock();
  });

  it('discovers videos and publishes jobs', async () => {
    const service = new ScanService(videoScanner, publisher, logger, '/v');
    const result = await service.runOnce();

    expect(videoScanner.findVideos).toHaveBeenCalledWith('/v');
    expect(publisher.publishThumbnailJobs).toHaveBeenCalledWith(['/v/a.mp4', '/v/b.mkv']);
    expect(result).toMatchObject({
      videosFound: 2,
      enqueued: 2,
      skipped: 0,
    });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('logs and rethrows when scanning fails', async () => {
    const err = new Error('fs down');
    (videoScanner.findVideos as ReturnType<typeof vi.fn>).mockRejectedValue(err);
    const service = new ScanService(videoScanner, publisher, logger, '/v');

    await expect(service.runOnce()).rejects.toThrow('fs down');
    expect(logger.error).toHaveBeenCalled();
    expect(publisher.publishThumbnailJobs).not.toHaveBeenCalled();
  });
});
