import { describe, it, expect } from 'vitest';
import {
  ConfigurationError,
  parseOneOf,
  parsePostgresConfig,
  parseRedisConfig,
  resolveWorkspacePath,
} from './index.js';

describe('parseRedisConfig', () => {
  it('uses defaults and only sets password when present', () => {
    expect(parseRedisConfig({})).toEqual({ host: '127.0.0.1', port: 6379 });
    expect(parseRedisConfig({ REDIS_PASSWORD: 'p' }).password).toBe('p');
  });

  it('rejects a non-integer port', () => {
    expect(() => parseRedisConfig({ REDIS_PORT: 'abc' })).toThrow(ConfigurationError);
  });
});

describe('parsePostgresConfig', () => {
  it('prefers DATABASE_URL but still validates POSTGRES_PORT', () => {
    expect(parsePostgresConfig({ DATABASE_URL: 'postgres://x' }).connectionString).toBe(
      'postgres://x',
    );
    expect(() =>
      parsePostgresConfig({ DATABASE_URL: 'postgres://x', POSTGRES_PORT: '-1' }),
    ).toThrow(ConfigurationError);
  });
});

describe('parseOneOf', () => {
  const levels = ['DEBUG', 'INFO'] as const;

  it('returns the fallback when unset and the value when allowed', () => {
    expect(parseOneOf('LOG_LEVEL', undefined, levels, 'INFO')).toBe('INFO');
    expect(parseOneOf('LOG_LEVEL', 'DEBUG', levels, 'INFO')).toBe('DEBUG');
  });

  it('rejects values outside the set', () => {
    expect(() => parseOneOf('LOG_LEVEL', 'LOUD', levels, 'INFO')).toThrow(ConfigurationError);
  });
});

describe('resolveWorkspacePath', () => {
  it('resolves relative paths against INIT_CWD', () => {
    expect(resolveWorkspacePath('./data', { INIT_CWD: '/repo' })).toBe('/repo/data');
    expect(resolveWorkspacePath('/abs', { INIT_CWD: '/repo' })).toBe('/abs');
  });
});
