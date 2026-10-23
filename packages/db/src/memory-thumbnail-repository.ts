import { randomUUID } from 'node:crypto';
import type { IThumbnailRepository, ThumbnailRecord, UpsertThumbnailInput } from './types.js';

/**
 * In-memory repository for unit tests — no Postgres required.
 */
export class InMemoryThumbnailRepository implements IThumbnailRepository {
  private readonly byVideoPath = new Map<string, ThumbnailRecord>();

  async findByVideoPath(videoPath: string): Promise<ThumbnailRecord | null> {
    return this.byVideoPath.get(videoPath) ?? null;
  }

  async findByThumbnailKey(thumbnailKey: string): Promise<ThumbnailRecord | null> {
    for (const record of this.byVideoPath.values()) {
      if (record.thumbnailKey === thumbnailKey) {
        return record;
      }
    }
    return null;
  }

  async upsert(input: UpsertThumbnailInput): Promise<ThumbnailRecord> {
    const existing = this.byVideoPath.get(input.videoPath);
    const now = new Date();
    const record: ThumbnailRecord = {
      id: existing?.id ?? randomUUID(),
      videoPath: input.videoPath,
      thumbnailKey: input.thumbnailKey,
      location: input.location,
      sizeBytes: input.sizeBytes,
      contentType: input.contentType ?? 'image/jpeg',
      status: input.status,
      correlationId: input.correlationId ?? null,
      durationMs: input.durationMs ?? null,
      videoSizeBytes: input.videoSizeBytes ?? null,
      errorMessage: input.errorMessage ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.byVideoPath.set(input.videoPath, record);
    return record;
  }

  clear(): void {
    this.byVideoPath.clear();
  }
}
