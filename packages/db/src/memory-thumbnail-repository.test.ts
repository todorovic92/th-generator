import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryThumbnailRepository } from './memory-thumbnail-repository.js';

describe('InMemoryThumbnailRepository', () => {
  let repo: InMemoryThumbnailRepository;

  beforeEach(() => {
    repo = new InMemoryThumbnailRepository();
  });

  it('upserts and finds by video path and thumbnail key', async () => {
    const saved = await repo.upsert({
      videoPath: '/videos/a.mp4',
      thumbnailKey: 'thumbnails/a.jpg',
      location: '/store/a.jpg',
      sizeBytes: 100,
      status: 'completed',
      correlationId: 'c1',
      durationMs: 50,
      videoSizeBytes: 1000,
    });

    expect(saved.id).toBeDefined();
    expect(await repo.findByVideoPath('/videos/a.mp4')).toMatchObject({
      thumbnailKey: 'thumbnails/a.jpg',
      status: 'completed',
      correlationId: 'c1',
    });
    expect(await repo.findByThumbnailKey('thumbnails/a.jpg')).toMatchObject({
      videoPath: '/videos/a.mp4',
    });
  });

  it('updates existing record on conflict and preserves id/createdAt', async () => {
    const first = await repo.upsert({
      videoPath: '/videos/a.mp4',
      thumbnailKey: 'thumbnails/old.jpg',
      location: '/store/old.jpg',
      sizeBytes: 1,
      status: 'failed',
      errorMessage: 'boom',
    });

    const second = await repo.upsert({
      videoPath: '/videos/a.mp4',
      thumbnailKey: 'thumbnails/new.jpg',
      location: '/store/new.jpg',
      sizeBytes: 2,
      status: 'completed',
    });

    expect(second.id).toBe(first.id);
    expect(second.createdAt).toEqual(first.createdAt);
    expect(second.thumbnailKey).toBe('thumbnails/new.jpg');
    expect(second.status).toBe('completed');
    expect(second.errorMessage).toBeNull();
  });

  it('returns null for missing lookups', async () => {
    expect(await repo.findByVideoPath('/missing')).toBeNull();
    expect(await repo.findByThumbnailKey('missing')).toBeNull();
  });
});
