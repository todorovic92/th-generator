import { DatabaseError } from './errors.js';
import type { ThumbnailRecord, ThumbnailStatus } from './types.js';

export interface ThumbnailRow {
  id: string;
  video_path: string;
  thumbnail_key: string;
  location: string;
  size_bytes: string | number;
  content_type: string;
  status: ThumbnailStatus;
  correlation_id: string | null;
  duration_ms: number | null;
  video_size_bytes: string | number | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Convert Postgres BIGINT / numeric fields without silent precision loss.
 * Values outside Number.MAX_SAFE_INTEGER throw instead of becoming wrong.
 */
export function toSafeInteger(value: string | number, field: string): number {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new DatabaseError(`BIGINT field ${field} is outside Number.MAX_SAFE_INTEGER`, {
        field,
        value,
      });
    }
    return value;
  }

  if (!/^-?\d+$/.test(value)) {
    throw new DatabaseError(`BIGINT field ${field} is not an integer string`, { field, value });
  }

  const asBigInt = BigInt(value);
  if (asBigInt > BigInt(Number.MAX_SAFE_INTEGER) || asBigInt < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DatabaseError(`BIGINT field ${field} is outside Number.MAX_SAFE_INTEGER`, {
      field,
      value,
    });
  }

  return Number(asBigInt);
}

export function mapThumbnailRow(row: ThumbnailRow): ThumbnailRecord {
  return {
    id: row.id,
    videoPath: row.video_path,
    thumbnailKey: row.thumbnail_key,
    location: row.location,
    sizeBytes: toSafeInteger(row.size_bytes, 'size_bytes'),
    contentType: row.content_type,
    status: row.status,
    correlationId: row.correlation_id,
    durationMs: row.duration_ms,
    videoSizeBytes:
      row.video_size_bytes === null
        ? null
        : toSafeInteger(row.video_size_bytes, 'video_size_bytes'),
    errorMessage: row.error_message,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
