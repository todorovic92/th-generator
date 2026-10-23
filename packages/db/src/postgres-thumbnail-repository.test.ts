import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresThumbnailRepository } from './postgres-thumbnail-repository.js';
import { DatabaseError } from './errors.js';

describe('PostgresThumbnailRepository', () => {
  let query: ReturnType<typeof vi.fn>;
  let repo: PostgresThumbnailRepository;

  beforeEach(() => {
    query = vi.fn();
    repo = new PostgresThumbnailRepository({ query } as never);
  });

  it('findByVideoPath returns mapped record or null', async () => {
    const now = new Date();
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          video_path: '/v.mp4',
          thumbnail_key: 'k',
          location: 'loc',
          size_bytes: 10,
          content_type: 'image/jpeg',
          status: 'completed',
          correlation_id: null,
          duration_ms: 5,
          video_size_bytes: null,
          error_message: null,
          created_at: now,
          updated_at: now,
        },
      ],
    });

    const found = await repo.findByVideoPath('/v.mp4');
    expect(found?.videoPath).toBe('/v.mp4');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('video_path'), ['/v.mp4']);

    query.mockResolvedValueOnce({ rows: [] });
    expect(await repo.findByVideoPath('/missing')).toBeNull();
  });

  it('upsert returns mapped row', async () => {
    const now = new Date();
    query.mockResolvedValueOnce({
      rows: [
        {
          id: '1',
          video_path: '/v.mp4',
          thumbnail_key: 'k',
          location: 'loc',
          size_bytes: 10,
          content_type: 'image/jpeg',
          status: 'completed',
          correlation_id: 'c',
          duration_ms: 5,
          video_size_bytes: 100,
          error_message: null,
          created_at: now,
          updated_at: now,
        },
      ],
    });

    const saved = await repo.upsert({
      videoPath: '/v.mp4',
      thumbnailKey: 'k',
      location: 'loc',
      sizeBytes: 10,
      status: 'completed',
      correlationId: 'c',
      durationMs: 5,
      videoSizeBytes: 100,
    });

    expect(saved.thumbnailKey).toBe('k');
    expect(query.mock.calls[0][0]).toContain('ON CONFLICT');
  });

  it('wraps query failures as DatabaseError', async () => {
    query.mockRejectedValueOnce(new Error('connection refused'));
    await expect(repo.findByVideoPath('/v.mp4')).rejects.toBeInstanceOf(DatabaseError);
  });
});
