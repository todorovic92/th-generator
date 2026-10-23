/**
 * Contract between scanner (producer) and generator (consumer).
 * Changing anything here changes what is stored in Redis — keep it serializable.
 */

/** BullMQ queue that carries thumbnail generation jobs. */
export const THUMBNAIL_QUEUE_NAME = 'thumbnail-generation';

export interface ThumbnailJobPayload {
  /** Absolute path to the source video on the shared filesystem. */
  videoPath: string;
  /** Optional job correlation id for tracing across services. */
  correlationId?: string;
  /** When the scanner discovered the file (ISO string). */
  discoveredAt: string;
}

export interface ThumbnailJobResult {
  videoPath: string;
  thumbnailKey: string;
  durationMs: number;
}

/** Default BullMQ job options tuned for long-running ffmpeg work. */
export const DEFAULT_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5_000,
  },
  removeOnComplete: {
    age: 24 * 3600,
    count: 1000,
  },
  removeOnFail: {
    age: 7 * 24 * 3600,
  },
};

export interface RedisConnectionConfig {
  host: string;
  port: number;
  password?: string;
}

/** BullMQ workers require maxRetriesPerRequest: null on their connection. */
export function createRedisConnectionOptions(config: RedisConnectionConfig) {
  return {
    host: config.host,
    port: config.port,
    ...(config.password ? { password: config.password } : {}),
    maxRetriesPerRequest: null as null,
  };
}
