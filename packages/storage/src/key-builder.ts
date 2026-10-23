import { createHash } from 'node:crypto';
import { basename, extname } from 'node:path';

/**
 * Builds stable, collision-resistant object keys for thumbnails.
 * Hashing the video path keeps keys unique across nested directories
 * with the same basename.
 */
export function buildThumbnailKey(videoPath: string, extension = '.jpg'): string {
  const hash = createHash('sha256').update(videoPath).digest('hex').slice(0, 16);
  const base = basename(videoPath, extname(videoPath));
  const safeBase = base.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  return `${safeBase}-${hash}${extension}`;
}
