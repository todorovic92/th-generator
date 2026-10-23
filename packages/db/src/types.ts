export type ThumbnailStatus = 'completed' | 'failed';

export interface ThumbnailRecord {
  id: string;
  videoPath: string;
  thumbnailKey: string;
  location: string;
  sizeBytes: number;
  contentType: string;
  status: ThumbnailStatus;
  correlationId: string | null;
  durationMs: number | null;
  videoSizeBytes: number | null;
  errorMessage: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertThumbnailInput {
  videoPath: string;
  thumbnailKey: string;
  location: string;
  sizeBytes: number;
  contentType?: string;
  status: ThumbnailStatus;
  correlationId?: string;
  durationMs?: number;
  videoSizeBytes?: number;
  errorMessage?: string;
}

/**
 * Persistence port for thumbnail metadata.
 * Postgres today; easy to swap for another SQL backend behind the same interface.
 */
export interface IThumbnailRepository {
  findByVideoPath(videoPath: string): Promise<ThumbnailRecord | null>;
  findByThumbnailKey(thumbnailKey: string): Promise<ThumbnailRecord | null>;
  upsert(input: UpsertThumbnailInput): Promise<ThumbnailRecord>;
}

export interface IDatabase {
  migrate(): Promise<void>;
  ping(): Promise<void>;
  close(): Promise<void>;
  thumbnails: IThumbnailRepository;
}
