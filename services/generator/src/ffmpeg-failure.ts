/**
 * Heuristics for classifying non-zero ffmpeg exits and process start failures.
 * Corrupt / unsupported media / permanent ACL / missing binary → non-retryable.
 * Disk / IO / tmp pressure / timeouts → transient (retryable).
 *
 * Keep patterns narrow — broad "error writing" matches corrupt-media trailers.
 */
const TRANSIENT_STDERR_PATTERNS = [
  'no space left',
  'enospc',
  'disk quota exceeded',
  // EROFS / "read-only file system" is permanent (matches storage classification) —
  // otherwise removeOnFail GC re-floods with no durable failed row.
  'i/o error',
  'input/output error',
  'resource temporarily unavailable',
  'eagain',
  'errno=28',
  'errno=11',
] as const;

const NON_RETRYABLE_PROCESS_PATTERNS = [
  'enoent',
  'spawn ffmpeg',
  'not found',
  'cannot find',
  'no such file',
] as const;

/** Sticky ACL / permission failures — do not burn retries then GC without durable failed. */
const PERMANENT_ERRNO = new Set(['EACCES', 'EPERM', 'EROFS', 'ENOTSUP', 'EILSEQ']);

export function isTransientFfmpegFailure(stderr: string, _exitCode: number): boolean {
  const haystack = stderr.toLowerCase();
  return TRANSIENT_STDERR_PATTERNS.some((pattern) => haystack.includes(pattern));
}

/**
 * Classify waitForCompletion / spawn failures.
 * Missing ffmpeg (ENOENT) is permanent; timeouts remain retryable.
 */
export function isRetryableProcessFailure(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return true;
  }

  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'ENOENT') {
    return false;
  }

  const message = error.message.toLowerCase();
  if (message.includes('timed out')) {
    return true;
  }
  if (NON_RETRYABLE_PROCESS_PATTERNS.some((pattern) => message.includes(pattern))) {
    return false;
  }

  return true;
}

/**
 * Storage/DB errors after a successful encode.
 * Permission / ACL / read-only → permanent; everything else stays transient.
 */
export function isRetryableStorageOrDbFailure(error: unknown): boolean {
  for (const candidate of walkErrorChain(error)) {
    const code = (candidate as NodeJS.ErrnoException).code;
    if (code && PERMANENT_ERRNO.has(code)) {
      return false;
    }
    const message = candidate.message.toLowerCase();
    if (
      message.includes('permission denied') ||
      message.includes('operation not permitted') ||
      message.includes('read-only file system')
    ) {
      return false;
    }
  }
  return true;
}

function walkErrorChain(error: unknown): Error[] {
  const out: Error[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    out.push(current);
    seen.add(current);
    current = current.cause;
  }
  return out;
}
