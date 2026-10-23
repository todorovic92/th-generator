import { describe, it, expect } from 'vitest';
import { AppError, isRetryableError } from './index.js';

describe('AppError', () => {
  it('defaults to non-retryable and preserves cause', () => {
    const cause = new Error('root');
    const err = new AppError('wrap', { code: 'X', cause });
    expect(err.retryable).toBe(false);
    expect(err.cause).toBe(cause);
    expect(err.name).toBe('AppError');
  });
});

describe('isRetryableError', () => {
  it('follows the AppError flag', () => {
    expect(isRetryableError(new AppError('a', { code: 'A', retryable: true }))).toBe(true);
    expect(isRetryableError(new AppError('b', { code: 'B' }))).toBe(false);
  });

  it('treats unknown errors as retryable (transient)', () => {
    expect(isRetryableError(new Error('x'))).toBe(true);
    expect(isRetryableError('x')).toBe(true);
  });
});
