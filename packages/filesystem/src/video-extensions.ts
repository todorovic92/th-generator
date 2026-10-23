/** Video extensions the scanner picks up. */
export const VIDEO_EXTENSIONS = [
  '.mp4',
  '.mkv',
  '.avi',
  '.mov',
  '.webm',
  '.m4v',
  '.wmv',
  '.flv',
] as const;

export function isVideoFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
}
