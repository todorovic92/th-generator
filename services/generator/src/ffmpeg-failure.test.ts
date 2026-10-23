import { describe, it, expect } from 'vitest';
import { StorageError } from '@thumbnail-generator/storage';
import {
  isRetryableProcessFailure,
  isRetryableStorageOrDbFailure,
  isTransientFfmpegFailure,
} from './ffmpeg-failure.js';

describe('isTransientFfmpegFailure', () => {
  it('treats disk-full / IO stderr as transient', () => {
    expect(isTransientFfmpegFailure('Error opening output: No space left on device', 1)).toBe(true);
    expect(isTransientFfmpegFailure('Cannot write: ENOSPC', 1)).toBe(true);
    expect(isTransientFfmpegFailure('Input/output error', 1)).toBe(true);
  });

  it('treats typical corrupt-media stderr as permanent', () => {
    expect(isTransientFfmpegFailure('Invalid data found when processing input', 1)).toBe(false);
    expect(isTransientFfmpegFailure('moov atom not found', 1)).toBe(false);
  });

  it('does not treat generic “error writing” / trailer messages as transient', () => {
    expect(isTransientFfmpegFailure('Error writing trailer of filename.mp4', 1)).toBe(false);
    expect(isTransientFfmpegFailure('Cannot write packet', 1)).toBe(false);
  });

  it('treats permission denied / ACL / EROFS as permanent', () => {
    expect(isTransientFfmpegFailure('Permission denied', 1)).toBe(false);
    expect(isTransientFfmpegFailure('errno=13', 1)).toBe(false);
    expect(isTransientFfmpegFailure('Read-only file system', 1)).toBe(false);
    expect(isTransientFfmpegFailure('errno=30', 1)).toBe(false);
  });

  it('treats EROFS as permanent for storage too', () => {
    const err = Object.assign(new Error('EROFS: read-only file system'), { code: 'EROFS' });
    expect(isRetryableStorageOrDbFailure(err)).toBe(false);
  });

  it('treats broken pipe as permanent (common on corrupt input)', () => {
    expect(isTransientFfmpegFailure('Error while decoding stream: Broken pipe', 1)).toBe(false);
    expect(isTransientFfmpegFailure('errno=32', 1)).toBe(false);
  });
});

describe('isRetryableStorageOrDbFailure', () => {
  it('treats EACCES / permission denied as permanent', () => {
    const err = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    expect(isRetryableStorageOrDbFailure(err)).toBe(false);
  });

  it('treats a StorageError wrapping a libc EACCES/EPERM as permanent', () => {
    for (const code of ['EACCES', 'EPERM', 'EROFS']) {
      const errno = Object.assign(new Error(`${code}: openat failed`), { code });
      const wrapped = new StorageError('Failed to store object', { key: 'k' }, errno);
      expect(isRetryableStorageOrDbFailure(wrapped)).toBe(false);
    }
  });

  it('treats generic failures as retryable', () => {
    expect(isRetryableStorageOrDbFailure(new Error('connection reset'))).toBe(true);
  });
});

describe('isRetryableProcessFailure', () => {
  it('treats missing ffmpeg (ENOENT) as permanent', () => {
    const err = Object.assign(new Error('spawn ffmpeg ENOENT'), { code: 'ENOENT' });
    expect(isRetryableProcessFailure(err)).toBe(false);
  });

  it('treats timeouts as retryable', () => {
    expect(isRetryableProcessFailure(new Error('ffmpeg timed out after 120000ms'))).toBe(true);
  });
});
