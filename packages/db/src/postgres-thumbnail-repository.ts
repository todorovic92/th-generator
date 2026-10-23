import type { Pool } from 'pg';
import { DatabaseError } from './errors.js';
import { mapThumbnailRow, type ThumbnailRow } from './mappers.js';
import type { IThumbnailRepository, ThumbnailRecord, UpsertThumbnailInput } from './types.js';

export class PostgresThumbnailRepository implements IThumbnailRepository {
  constructor(private readonly pool: Pool) {}

  async findByVideoPath(videoPath: string): Promise<ThumbnailRecord | null> {
    try {
      const result = await this.pool.query<ThumbnailRow>(
        `SELECT * FROM thumbnails WHERE video_path = $1`,
        [videoPath],
      );
      const row = result.rows[0];
      return row ? mapThumbnailRow(row) : null;
    } catch (error) {
      throw new DatabaseError('Failed to find thumbnail by video path', { videoPath }, error);
    }
  }

  async findByThumbnailKey(thumbnailKey: string): Promise<ThumbnailRecord | null> {
    try {
      const result = await this.pool.query<ThumbnailRow>(
        `SELECT * FROM thumbnails WHERE thumbnail_key = $1`,
        [thumbnailKey],
      );
      const row = result.rows[0];
      return row ? mapThumbnailRow(row) : null;
    } catch (error) {
      throw new DatabaseError('Failed to find thumbnail by key', { thumbnailKey }, error);
    }
  }

  async upsert(input: UpsertThumbnailInput): Promise<ThumbnailRecord> {
    try {
      const result = await this.pool.query<ThumbnailRow>(
        `
        INSERT INTO thumbnails (
          video_path,
          thumbnail_key,
          location,
          size_bytes,
          content_type,
          status,
          correlation_id,
          duration_ms,
          video_size_bytes,
          error_message
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        ON CONFLICT (video_path) DO UPDATE SET
          thumbnail_key = EXCLUDED.thumbnail_key,
          location = EXCLUDED.location,
          size_bytes = EXCLUDED.size_bytes,
          content_type = EXCLUDED.content_type,
          status = EXCLUDED.status,
          correlation_id = EXCLUDED.correlation_id,
          duration_ms = EXCLUDED.duration_ms,
          video_size_bytes = EXCLUDED.video_size_bytes,
          error_message = EXCLUDED.error_message,
          updated_at = NOW()
        RETURNING *
        `,
        [
          input.videoPath,
          input.thumbnailKey,
          input.location,
          input.sizeBytes,
          input.contentType ?? 'image/jpeg',
          input.status,
          input.correlationId ?? null,
          input.durationMs ?? null,
          input.videoSizeBytes ?? null,
          input.errorMessage ?? null,
        ],
      );

      const row = result.rows[0];
      if (!row) {
        throw new DatabaseError('Upsert returned no row', { videoPath: input.videoPath });
      }
      return mapThumbnailRow(row);
    } catch (error) {
      if (error instanceof DatabaseError) {
        throw error;
      }
      throw new DatabaseError(
        'Failed to upsert thumbnail metadata',
        { videoPath: input.videoPath, thumbnailKey: input.thumbnailKey },
        error,
      );
    }
  }
}
