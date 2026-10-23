import { describe, it, expect } from 'vitest';
import { mapThumbnailRow, toSafeInteger } from './mappers.js';
import { DatabaseError } from './errors.js';

describe('mapThumbnailRow', () => {
  it('maps snake_case rows to camelCase records', () => {
    const now = new Date('2024-06-01T12:00:00Z');
    const record = mapThumbnailRow({
      id: 'uuid-1',
      video_path: '/v/a.mp4',
      thumbnail_key: 'thumbnails/a.jpg',
      location: '/data/thumbnails/a.jpg',
      size_bytes: '2048',
      content_type: 'image/jpeg',
      status: 'completed',
      correlation_id: 'c1',
      duration_ms: 120,
      video_size_bytes: '9999',
      error_message: null,
      created_at: now,
      updated_at: now,
    });

    expect(record).toEqual({
      id: 'uuid-1',
      videoPath: '/v/a.mp4',
      thumbnailKey: 'thumbnails/a.jpg',
      location: '/data/thumbnails/a.jpg',
      sizeBytes: 2048,
      contentType: 'image/jpeg',
      status: 'completed',
      correlationId: 'c1',
      durationMs: 120,
      videoSizeBytes: 9999,
      errorMessage: null,
      createdAt: now,
      updatedAt: now,
    });
  });
});

describe('toSafeInteger', () => {
  it('accepts safe integer strings and numbers', () => {
    expect(toSafeInteger('42', 'x')).toBe(42);
    expect(toSafeInteger(42, 'x')).toBe(42);
  });

  it('rejects values beyond MAX_SAFE_INTEGER', () => {
    const tooBig = String(BigInt(Number.MAX_SAFE_INTEGER) + 1n);
    expect(() => toSafeInteger(tooBig, 'size_bytes')).toThrow(DatabaseError);
  });
});
