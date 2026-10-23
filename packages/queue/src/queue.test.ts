import { describe, it, expect } from 'vitest';
import { createRedisConnectionOptions, DEFAULT_JOB_OPTIONS } from './index.js';

describe('createRedisConnectionOptions', () => {
  it('sets maxRetriesPerRequest to null and omits an empty password', () => {
    expect(createRedisConnectionOptions({ host: 'h', port: 1 })).toEqual({
      host: 'h',
      port: 1,
      maxRetriesPerRequest: null,
    });
    expect(createRedisConnectionOptions({ host: 'h', port: 1, password: 'p' }).password).toBe('p');
  });
});

describe('DEFAULT_JOB_OPTIONS', () => {
  it('keeps failed jobs longer than completed ones', () => {
    expect(DEFAULT_JOB_OPTIONS.removeOnFail.age).toBeGreaterThan(
      DEFAULT_JOB_OPTIONS.removeOnComplete.age,
    );
  });
});
