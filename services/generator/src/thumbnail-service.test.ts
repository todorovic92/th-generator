import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { InMemoryThumbnailRepository } from '@thumbnail-generator/db';
import { ThumbnailService } from './thumbnail-service.js';
import type { IProcess, StartThumbnailProcess } from './thumbnail-process.js';
import {
  FileSystemError,
  PathNotFoundError,
  type IFileSystem,
  type FileInfo,
} from '@thumbnail-generator/filesystem';
import { isRetryableError } from '@thumbnail-generator/errors';
import type { IObjectStorage, StoredObject } from '@thumbnail-generator/storage';
import type { ILogger } from '@thumbnail-generator/logger';
import { ThumbnailProcessError, VideoNotFoundError } from './errors.js';

function createLoggerMock(): ILogger {
  const logger: ILogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(() => logger),
    setLevel: vi.fn(),
  };
  return logger;
}

function successProcess(writeOutput: (path: string) => Promise<void>): StartThumbnailProcess {
  return (_videoPath, outputPath) => {
    const handle: IProcess = {
      kill: vi.fn().mockResolvedValue(undefined),
      waitForCompletion: async () => {
        await writeOutput(outputPath);
        return 0;
      },
      getStderr: () => '',
    };
    return handle;
  };
}

describe('ThumbnailService', () => {
  let tempRoot: string;
  let fs: IFileSystem;
  let storage: IObjectStorage;
  let thumbnails: InMemoryThumbnailRepository;
  let logger: ILogger;
  let putObject: ReturnType<typeof vi.fn>;
  let statObject: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    tempRoot = await mkdtemp(join(tmpdir(), 'tg-svc-'));
    logger = createLoggerMock();
    thumbnails = new InMemoryThumbnailRepository();

    fs = {
      exists: vi.fn().mockResolvedValue(true),
      openFile: vi.fn().mockResolvedValue({
        name: 'clip.mp4',
        path: '/videos/clip.mp4',
        permissions: 0o644,
        size: 1024,
        isDirectory: false,
        modifiedAt: new Date(),
      } satisfies FileInfo),
      listFiles: vi.fn(),
    };

    putObject = vi
      .fn()
      .mockImplementation(async ({ key }: { key: string }): Promise<StoredObject> => ({
        key,
        location: `/store/${key}`,
        size: 42,
      }));

    statObject = vi.fn().mockResolvedValue(null);

    storage = {
      putObject,
      exists: vi.fn().mockResolvedValue(false),
      statObject,
      deleteObject: vi.fn(),
      getLocation: vi.fn((key: string) => `/store/${key}`),
    };
  });

  afterEach(async () => {
    await rm(tempRoot, { recursive: true, force: true });
  });

  it('generates a thumbnail, stores it, and persists metadata', async () => {
    const start = successProcess(async (outputPath) => {
      await writeFile(outputPath, 'jpeg-bytes');
    });

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: start,
      logger,
      tempDirRoot: tempRoot,
    });

    const result = await service.generate({
      videoPath: '/videos/clip.mp4',
      discoveredAt: new Date().toISOString(),
      correlationId: 'c1',
    });

    expect(result.videoPath).toBe('/videos/clip.mp4');
    expect(result.thumbnailKey).toMatch(/^clip-/);
    expect(putObject).toHaveBeenCalledOnce();
    expect(result.durationMs).toBeGreaterThanOrEqual(0);

    const meta = await thumbnails.findByVideoPath('/videos/clip.mp4');
    expect(meta).toMatchObject({
      status: 'completed',
      correlationId: 'c1',
      sizeBytes: 42,
      videoSizeBytes: 1024,
    });
  });

  it('skips generation when metadata completed AND object exists', async () => {
    await thumbnails.upsert({
      videoPath: '/videos/clip.mp4',
      thumbnailKey: 'existing.jpg',
      location: '/store/existing.jpg',
      sizeBytes: 10,
      status: 'completed',
    });
    (storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(true);
    const start = vi.fn();

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: start,
      logger,
      tempDirRoot: tempRoot,
    });

    const result = await service.generate({
      videoPath: '/videos/clip.mp4',
      discoveredAt: new Date().toISOString(),
    });

    expect(start).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    expect(result.thumbnailKey).toBe('existing.jpg');
  });

  it('regenerates when metadata is completed but object is missing', async () => {
    await thumbnails.upsert({
      videoPath: '/videos/clip.mp4',
      thumbnailKey: 'missing.jpg',
      location: '/store/missing.jpg',
      sizeBytes: 10,
      status: 'completed',
    });
    (storage.exists as ReturnType<typeof vi.fn>).mockResolvedValue(false);

    const start = successProcess(async (outputPath) => {
      await writeFile(outputPath, 'jpeg-bytes');
    });

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: start,
      logger,
      tempDirRoot: tempRoot,
    });

    const result = await service.generate({
      videoPath: '/videos/clip.mp4',
      discoveredAt: new Date().toISOString(),
    });

    expect(putObject).toHaveBeenCalledOnce();
    expect(result.thumbnailKey).toMatch(/^clip-/);
  });

  it('skips ffmpeg when object exists and upserts metadata with real size', async () => {
    statObject.mockResolvedValue({
      key: 'clip-abc.jpg',
      location: '/store/clip-abc.jpg',
      size: 987,
    });
    const start = vi.fn();

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: start,
      logger,
      tempDirRoot: tempRoot,
    });

    // Force the built key path by mocking build via exists on computed key —
    // statObject is called with buildThumbnailKey result; mock any key.
    statObject.mockImplementation(async (key: string) => ({
      key,
      location: `/store/${key}`,
      size: 987,
    }));

    const result = await service.generate({
      videoPath: '/videos/clip.mp4',
      discoveredAt: new Date().toISOString(),
      correlationId: 'c2',
    });

    expect(start).not.toHaveBeenCalled();
    expect(putObject).not.toHaveBeenCalled();
    expect(result.thumbnailKey).toMatch(/\.jpg$/);

    const meta = await thumbnails.findByVideoPath('/videos/clip.mp4');
    expect(meta?.status).toBe('completed');
    expect(meta?.correlationId).toBe('c2');
    expect(meta?.sizeBytes).toBe(987);
  });

  it('throws VideoNotFoundError and persists failed when file is missing', async () => {
    (fs.openFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PathNotFoundError('/missing.mp4'),
    );
    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: vi.fn(),
      logger,
      tempDirRoot: tempRoot,
    });

    await expect(
      service.generate({
        videoPath: '/missing.mp4',
        discoveredAt: new Date().toISOString(),
      }),
    ).rejects.toBeInstanceOf(VideoNotFoundError);

    const meta = await thumbnails.findByVideoPath('/missing.mp4');
    expect(meta?.status).toBe('failed');
    expect(meta?.errorMessage).toContain('Video not found');
  });

  it.each(['EACCES', 'EMFILE', 'EIO'])(
    'keeps %s while opening the video retryable and records no failed row',
    async (code) => {
      const cause = Object.assign(new Error(`${code}: stat failed`), { code });
      (fs.openFile as ReturnType<typeof vi.fn>).mockRejectedValue(
        new FileSystemError('Failed to open file /flaky.mp4', { path: '/flaky.mp4' }, cause),
      );
      const start = vi.fn();
      const service = new ThumbnailService({
        fs,
        storage,
        thumbnails,
        startThumbnailProcess: start,
        logger,
        tempDirRoot: tempRoot,
      });

      const error = await service
        .generate({ videoPath: '/flaky.mp4', discoveredAt: new Date().toISOString() })
        .then(
          () => undefined,
          (caught: unknown) => caught,
        );

      expect(error).toBeInstanceOf(FileSystemError);
      expect(error).not.toBeInstanceOf(VideoNotFoundError);
      expect(isRetryableError(error)).toBe(true);
      expect(start).not.toHaveBeenCalled();
      expect(await thumbnails.findByVideoPath('/flaky.mp4')).toBeNull();
    },
  );

  it('persists failed metadata and marks corrupt media as non-retryable', async () => {
    const start: StartThumbnailProcess = () => ({
      kill: vi.fn().mockResolvedValue(undefined),
      waitForCompletion: async () => 1,
      getStderr: () => 'Invalid data found',
    });

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: start,
      logger,
      tempDirRoot: tempRoot,
    });

    let caught: unknown;
    try {
      await service.generate({
        videoPath: '/videos/clip.mp4',
        discoveredAt: new Date().toISOString(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ThumbnailProcessError);
    expect((caught as ThumbnailProcessError).retryable).toBe(false);

    const meta = await thumbnails.findByVideoPath('/videos/clip.mp4');
    expect(meta?.status).toBe('failed');
    expect(meta?.errorMessage).toContain('Invalid data found');
  });

  it('treats disk-full ffmpeg exits as retryable without persisting failed', async () => {
    const start: StartThumbnailProcess = () => ({
      kill: vi.fn().mockResolvedValue(undefined),
      waitForCompletion: async () => 1,
      getStderr: () => 'Error opening output file: No space left on device',
    });

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: start,
      logger,
      tempDirRoot: tempRoot,
    });

    let caught: unknown;
    try {
      await service.generate({
        videoPath: '/videos/clip.mp4',
        discoveredAt: new Date().toISOString(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ThumbnailProcessError);
    expect((caught as ThumbnailProcessError).retryable).toBe(true);
    expect(await thumbnails.findByVideoPath('/videos/clip.mp4')).toBeNull();
  });

  it('does not persist failed metadata for retryable timeouts/crashes', async () => {
    const start: StartThumbnailProcess = () => ({
      kill: vi.fn().mockResolvedValue(undefined),
      waitForCompletion: async () => {
        throw new Error('ffmpeg timed out after 120000ms');
      },
      getStderr: () => '',
    });

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: start,
      logger,
      tempDirRoot: tempRoot,
    });

    let caught: unknown;
    try {
      await service.generate({
        videoPath: '/videos/clip.mp4',
        discoveredAt: new Date().toISOString(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ThumbnailProcessError);
    expect((caught as ThumbnailProcessError).retryable).toBe(true);
    expect(await thumbnails.findByVideoPath('/videos/clip.mp4')).toBeNull();
  });

  it('persists failed and marks missing ffmpeg as non-retryable', async () => {
    const start: StartThumbnailProcess = () => ({
      kill: vi.fn().mockResolvedValue(undefined),
      waitForCompletion: async () => {
        throw Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
      },
      getStderr: () => '',
    });

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: start,
      logger,
      tempDirRoot: tempRoot,
    });

    let caught: unknown;
    try {
      await service.generate({
        videoPath: '/videos/clip.mp4',
        discoveredAt: new Date().toISOString(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ThumbnailProcessError);
    expect((caught as ThumbnailProcessError).retryable).toBe(false);
    const meta = await thumbnails.findByVideoPath('/videos/clip.mp4');
    expect(meta?.status).toBe('failed');
  });

  it('keeps permanent failures retryable when durable failed cannot be written', async () => {
    thumbnails.upsert = vi.fn().mockRejectedValue(new Error('db down'));
    (fs.openFile as ReturnType<typeof vi.fn>).mockRejectedValue(
      new PathNotFoundError('/missing.mp4'),
    );

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: vi.fn(),
      logger,
      tempDirRoot: tempRoot,
    });

    let caught: unknown;
    try {
      await service.generate({
        videoPath: '/missing.mp4',
        discoveredAt: new Date().toISOString(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ThumbnailProcessError);
    expect((caught as ThumbnailProcessError).retryable).toBe(true);
  });

  it('persists failed for permanent storage ACL errors after encode', async () => {
    const start = successProcess(async (outputPath) => {
      await writeFile(outputPath, 'jpeg-bytes');
    });
    putObject.mockRejectedValue(
      Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' }),
    );

    const service = new ThumbnailService({
      fs,
      storage,
      thumbnails,
      startThumbnailProcess: start,
      logger,
      tempDirRoot: tempRoot,
    });

    let caught: unknown;
    try {
      await service.generate({
        videoPath: '/videos/clip.mp4',
        discoveredAt: new Date().toISOString(),
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(ThumbnailProcessError);
    expect((caught as ThumbnailProcessError).retryable).toBe(false);
    expect(await thumbnails.findByVideoPath('/videos/clip.mp4')).toMatchObject({
      status: 'failed',
    });
  });
});
