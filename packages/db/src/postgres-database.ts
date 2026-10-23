import pg, { type Pool, type PoolConfig } from 'pg';
import type { ILogger } from '@thumbnail-generator/logger';
import { DatabaseError } from './errors.js';
import {
  MIGRATIONS,
  REQUIRED_THUMBNAIL_COLUMNS,
  SCHEMA_MIGRATIONS_DDL,
  VERIFY_THUMBNAILS_COLUMNS_SQL,
  VERIFY_THUMBNAILS_CONSTRAINTS_SQL,
} from './migrations.js';
import { PostgresThumbnailRepository } from './postgres-thumbnail-repository.js';
import type { IDatabase } from './types.js';

export interface PostgresDatabaseOptions {
  connectionString?: string;
  host?: string;
  port?: number;
  user?: string;
  password?: string;
  database?: string;
  max?: number;
  logger?: ILogger;
  /** Test seam — inject a Pool (or compatible mock). */
  pool?: Pool;
}

export class PostgresDatabase implements IDatabase {
  readonly thumbnails: PostgresThumbnailRepository;
  private readonly pool: Pool;
  private readonly logger?: ILogger;

  constructor(options: PostgresDatabaseOptions) {
    this.logger = options.logger;

    if (options.pool) {
      this.pool = options.pool;
    } else {
      const config: PoolConfig = options.connectionString
        ? {
            connectionString: options.connectionString,
            max: options.max ?? 10,
          }
        : {
            host: options.host ?? '127.0.0.1',
            port: options.port ?? 5432,
            user: options.user ?? 'postgres',
            password: options.password ?? 'postgres',
            database: options.database ?? 'thumbnail_generator',
            max: options.max ?? 10,
          };
      this.pool = new pg.Pool(config);
    }

    // Idle client errors must be handled or Node treats them as uncaught and exits.
    this.pool.on('error', (error) => {
      this.logger?.error('Unexpected idle Postgres client error', {}, error);
    });
    this.thumbnails = new PostgresThumbnailRepository(this.pool);
  }

  async migrate(): Promise<void> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      // Serialize scanner + generator cold-start migrates (check-then-CREATE TABLE).
      // Transaction-scoped: released automatically on COMMIT/ROLLBACK.
      await client.query('SELECT pg_advisory_xact_lock($1)', [MIGRATE_ADVISORY_LOCK_KEY]);
      await client.query(SCHEMA_MIGRATIONS_DDL);

      for (const migration of MIGRATIONS) {
        const existing = await client.query<{ id: string }>(
          `SELECT id FROM schema_migrations WHERE id = $1`,
          [migration.id],
        );
        if (existing.rowCount && existing.rowCount > 0) {
          continue;
        }

        this.logger?.info('Applying database migration', { id: migration.id });
        await client.query(migration.sql);
        await client.query(`INSERT INTO schema_migrations (id) VALUES ($1)`, [migration.id]);
      }

      await this.verifyThumbnailsSchema(client);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw new DatabaseError('Failed to run database migrations', {}, error);
    } finally {
      client.release();
    }
  }

  async ping(): Promise<void> {
    try {
      await this.pool.query('SELECT 1');
    } catch (error) {
      throw new DatabaseError('Database ping failed', {}, error);
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async verifyThumbnailsSchema(client: {
    query: <T extends Record<string, unknown> = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ) => Promise<{ rows: T[] }>;
  }): Promise<void> {
    const columns = await client.query<{
      column_name: string;
      data_type: string;
      udt_name: string;
    }>(VERIFY_THUMBNAILS_COLUMNS_SQL);

    const byName = new Map(columns.rows.map((row) => [row.column_name, row] as const));

    const missing: string[] = [];
    const typeMismatches: Array<{ column: string; expected: string; actual: string }> = [];

    for (const expected of REQUIRED_THUMBNAIL_COLUMNS) {
      const actual = byName.get(expected.name);
      if (!actual) {
        missing.push(expected.name);
        continue;
      }
      const typeOk = actual.data_type === expected.dataType || actual.udt_name === expected.udtName;
      if (!typeOk) {
        typeMismatches.push({
          column: expected.name,
          expected: `${expected.dataType}/${expected.udtName}`,
          actual: `${actual.data_type}/${actual.udt_name}`,
        });
      }
    }

    if (missing.length > 0 || typeMismatches.length > 0) {
      throw new DatabaseError('thumbnails table schema does not match migrations (columns/types)', {
        missing,
        typeMismatches,
      });
    }

    const constraints = await client.query<{
      name: string;
      type: string;
      definition: string;
    }>(VERIFY_THUMBNAILS_CONSTRAINTS_SQL);

    const hasVideoPathUnique = constraints.rows.some(
      (row) => row.type === 'u' && isUniqueOnVideoPathOnly(row.definition),
    );
    const hasStatusCheck = constraints.rows.some(
      (row) => row.type === 'c' && isStatusCheckConstraint(row.definition),
    );
    const hasPrimaryKey = constraints.rows.some((row) => row.type === 'p');

    if (!hasPrimaryKey || !hasVideoPathUnique || !hasStatusCheck) {
      throw new DatabaseError(
        'thumbnails table is missing required constraints (PK / UNIQUE(video_path) only / status CHECK)',
        {
          hasPrimaryKey,
          hasVideoPathUnique,
          hasStatusCheck,
          constraints: constraints.rows,
        },
      );
    }
  }
}

/**
 * Stable advisory-lock key for migrate(). Must not collide with app locks.
 * Derived from hashtext('thumbnail_generator.migrate') ≈ fixed int8.
 */
export const MIGRATE_ADVISORY_LOCK_KEY = 872_014_331;

/** Accept UNIQUE (video_path) only — reject composite uniques like (video_path, status). */
export function isUniqueOnVideoPathOnly(definition: string): boolean {
  const normalized = definition.toLowerCase().replace(/\s+/g, '');
  return (
    normalized === 'unique(video_path)' ||
    normalized === 'unique("video_path")' ||
    normalized === 'unique(public.video_path)'
  );
}

/**
 * Accept only CHECK constraints whose entire body is exactly status ∈ {completed, failed}.
 * Substring matches like CHECK (status IN (...) OR true) must fail.
 */
export function isStatusCheckConstraint(definition: string): boolean {
  const normalized = definition.toLowerCase().replace(/\s+/g, '');
  if (!normalized.startsWith('check(') || !normalized.endsWith(')')) {
    return false;
  }

  let body = normalized.slice('check('.length, -1);
  // Postgres often wraps the expression in an extra pair of parens.
  while (body.startsWith('(') && body.endsWith(')') && isBalancedParens(body)) {
    body = body.slice(1, -1);
  }

  const allowed = new Set([
    "status=any(array['completed'::text,'failed'::text])",
    "status=any(array['failed'::text,'completed'::text])",
    "status::text=any(array['completed'::text,'failed'::text])",
    "status::text=any(array['failed'::text,'completed'::text])",
    "statusin('completed','failed')",
    "statusin('failed','completed')",
  ]);
  return allowed.has(body);
}

/** True when the outermost parens wrap the whole string (not e.g. `(a)or(b)`). */
function isBalancedParens(s: string): boolean {
  if (!s.startsWith('(') || !s.endsWith(')')) {
    return false;
  }
  let depth = 0;
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i];
    if (ch === '(') {
      depth += 1;
    } else if (ch === ')') {
      depth -= 1;
      if (depth === 0 && i !== s.length - 1) {
        return false;
      }
      if (depth < 0) {
        return false;
      }
    }
  }
  return depth === 0;
}

export function createPostgresDatabase(options: PostgresDatabaseOptions): PostgresDatabase {
  return new PostgresDatabase(options);
}
