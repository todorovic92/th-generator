import { isAbsolute, resolve } from 'node:path';

/** Invalid environment at startup. Never retried — the process should exit. */
export class ConfigurationError extends Error {
  readonly details?: Record<string, unknown>;

  constructor(message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = 'ConfigurationError';
    this.details = details;
  }
}

/**
 * Resolve a filesystem path for monorepo services.
 * Relative paths use npm's INIT_CWD (repo root when using workspace scripts),
 * otherwise process.cwd(). Absolute paths are returned unchanged.
 */
export function resolveWorkspacePath(
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  if (isAbsolute(path)) {
    return path;
  }
  return resolve(env.INIT_CWD ?? cwd, path);
}

/** Validate a value against a fixed set of allowed strings. */
export function parseOneOf<T extends string>(
  name: string,
  value: string | undefined,
  allowed: readonly T[],
  fallback: T,
): T {
  if (value === undefined || value === '') {
    return fallback;
  }
  if (!(allowed as readonly string[]).includes(value)) {
    throw new ConfigurationError(`${name} must be one of ${allowed.join(', ')}`, { value });
  }
  return value as T;
}

export interface RedisConfig {
  host: string;
  port: number;
  password?: string;
}

export interface PostgresConfig {
  /** Prefer a single connection string when set. */
  connectionString?: string;
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
}

export function parseRedisConfig(env: NodeJS.ProcessEnv = process.env): RedisConfig {
  return {
    host: env.REDIS_HOST ?? '127.0.0.1',
    port: parsePort('REDIS_PORT', env.REDIS_PORT, 6379),
    ...(env.REDIS_PASSWORD ? { password: env.REDIS_PASSWORD } : {}),
  };
}

export function parsePostgresConfig(env: NodeJS.ProcessEnv = process.env): PostgresConfig {
  const discrete = {
    host: env.POSTGRES_HOST ?? '127.0.0.1',
    port: parsePort('POSTGRES_PORT', env.POSTGRES_PORT, 5432),
    user: env.POSTGRES_USER ?? 'postgres',
    password: env.POSTGRES_PASSWORD ?? 'postgres',
    database: env.POSTGRES_DB ?? 'thumbnail_generator',
  };
  return env.DATABASE_URL ? { connectionString: env.DATABASE_URL, ...discrete } : discrete;
}

function parsePort(name: string, value: string | undefined, fallback: number): number {
  const port = Number(value ?? String(fallback));
  if (!Number.isInteger(port) || port <= 0) {
    throw new ConfigurationError(`${name} must be a positive integer`, { value });
  }
  return port;
}
