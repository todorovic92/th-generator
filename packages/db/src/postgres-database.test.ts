import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PostgresDatabase } from './postgres-database.js';
import { MIGRATIONS, REQUIRED_THUMBNAIL_COLUMNS } from './migrations.js';
import { DatabaseError } from './errors.js';
import type { ILogger } from '@thumbnail-generator/logger';

function healthyColumns() {
  return REQUIRED_THUMBNAIL_COLUMNS.map((col) => ({
    column_name: col.name,
    data_type: col.dataType,
    udt_name: col.udtName,
  }));
}

function healthyConstraints() {
  return [
    { name: 'thumbnails_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
    {
      name: 'thumbnails_video_path_unique',
      type: 'u',
      definition: 'UNIQUE (video_path)',
    },
    {
      name: 'thumbnails_status_check',
      type: 'c',
      definition: "CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])))",
    },
  ];
}

describe('PostgresDatabase', () => {
  let on: ReturnType<typeof vi.fn>;
  let query: ReturnType<typeof vi.fn>;
  let release: ReturnType<typeof vi.fn>;
  let connect: ReturnType<typeof vi.fn>;
  let logger: ILogger;

  beforeEach(() => {
    on = vi.fn();
    query = vi.fn();
    release = vi.fn();
    connect = vi.fn().mockResolvedValue({ query, release });
    logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      fatal: vi.fn(),
      child: vi.fn(function (this: ILogger) {
        return this;
      }),
      setLevel: vi.fn(),
    };
  });

  it('registers an idle client error listener', () => {
    new PostgresDatabase({
      pool: { on, query: vi.fn(), connect, end: vi.fn() } as never,
      logger,
    });

    expect(on).toHaveBeenCalledWith('error', expect.any(Function));
  });

  it('applies pending migrations, verifies schema, and skips already-applied ones', async () => {
    const applied = new Set<string>();
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('pg_advisory_xact_lock')) {
        return { rows: [{ pg_advisory_xact_lock: '' }] };
      }
      if (sql.includes('schema_migrations') && sql.includes('CREATE')) {
        return { rows: [] };
      }
      if (sql.includes('SELECT id FROM schema_migrations')) {
        const id = params?.[0] as string;
        return { rows: applied.has(id) ? [{ id }] : [], rowCount: applied.has(id) ? 1 : 0 };
      }
      if (sql.includes('INSERT INTO schema_migrations')) {
        applied.add(params?.[0] as string);
        return { rows: [] };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: healthyColumns() };
      }
      if (sql.includes('pg_constraint')) {
        return { rows: healthyConstraints() };
      }
      return { rows: [] };
    });

    const db = new PostgresDatabase({
      pool: { on, query: vi.fn(), connect, end: vi.fn() } as never,
      logger,
    });

    await db.migrate();
    expect(applied.size).toBe(MIGRATIONS.length);
    expect(query).toHaveBeenCalledWith('SELECT pg_advisory_xact_lock($1)', [872_014_331]);

    await db.migrate();
    expect(applied.size).toBe(MIGRATIONS.length);
    expect(logger.info).toHaveBeenCalled();
  });

  it('fails migrate when thumbnails table is missing required columns', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('schema_migrations')) {
        return { rows: [{ id: '001_init_thumbnails' }], rowCount: 1 };
      }
      if (sql.includes('information_schema.columns')) {
        return {
          rows: [
            { column_name: 'id', data_type: 'uuid', udt_name: 'uuid' },
            { column_name: 'video_path', data_type: 'text', udt_name: 'text' },
          ],
        };
      }
      return { rows: [] };
    });

    const db = new PostgresDatabase({
      pool: { on, query: vi.fn(), connect, end: vi.fn() } as never,
      logger,
    });

    await expect(db.migrate()).rejects.toBeInstanceOf(DatabaseError);
  });

  it('fails migrate when column types or constraints are wrong', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('schema_migrations')) {
        return { rows: [{ id: '001_init_thumbnails' }], rowCount: 1 };
      }
      if (sql.includes('information_schema.columns')) {
        return {
          rows: healthyColumns().map((col) =>
            col.column_name === 'size_bytes'
              ? { ...col, data_type: 'integer', udt_name: 'int4' }
              : col,
          ),
        };
      }
      if (sql.includes('pg_constraint')) {
        return { rows: healthyConstraints() };
      }
      return { rows: [] };
    });

    const db = new PostgresDatabase({
      pool: { on, query: vi.fn(), connect, end: vi.fn() } as never,
      logger,
    });

    await expect(db.migrate()).rejects.toBeInstanceOf(DatabaseError);
  });

  it('fails migrate when UNIQUE or CHECK constraints are missing', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('schema_migrations')) {
        return { rows: [{ id: '001_init_thumbnails' }], rowCount: 1 };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: healthyColumns() };
      }
      if (sql.includes('pg_constraint')) {
        return {
          rows: [{ name: 'thumbnails_pkey', type: 'p', definition: 'PRIMARY KEY (id)' }],
        };
      }
      return { rows: [] };
    });

    const db = new PostgresDatabase({
      pool: { on, query: vi.fn(), connect, end: vi.fn() } as never,
      logger,
    });

    await expect(db.migrate()).rejects.toBeInstanceOf(DatabaseError);
  });

  it('rejects composite UNIQUE (video_path, status)', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('schema_migrations')) {
        return { rows: [{ id: '001_init_thumbnails' }], rowCount: 1 };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: healthyColumns() };
      }
      if (sql.includes('pg_constraint')) {
        return {
          rows: [
            { name: 'thumbnails_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
            {
              name: 'thumbnails_video_path_status_unique',
              type: 'u',
              definition: 'UNIQUE (video_path, status)',
            },
            {
              name: 'thumbnails_status_check',
              type: 'c',
              definition: "CHECK ((status = ANY (ARRAY['completed'::text, 'failed'::text])))",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const db = new PostgresDatabase({
      pool: { on, query: vi.fn(), connect, end: vi.fn() } as never,
      logger,
    });

    await expect(db.migrate()).rejects.toBeInstanceOf(DatabaseError);
  });

  it('rejects loose status CHECK that only mentions completed/failed', async () => {
    query.mockImplementation(async (sql: string) => {
      if (sql === 'BEGIN' || sql === 'COMMIT' || sql === 'ROLLBACK') {
        return { rows: [] };
      }
      if (sql.includes('schema_migrations')) {
        return { rows: [{ id: '001_init_thumbnails' }], rowCount: 1 };
      }
      if (sql.includes('information_schema.columns')) {
        return { rows: healthyColumns() };
      }
      if (sql.includes('pg_constraint')) {
        return {
          rows: [
            { name: 'thumbnails_pkey', type: 'p', definition: 'PRIMARY KEY (id)' },
            {
              name: 'thumbnails_video_path_unique',
              type: 'u',
              definition: 'UNIQUE (video_path)',
            },
            {
              name: 'thumbnails_status_check',
              type: 'c',
              definition:
                "CHECK ((status IS NOT NULL OR status = 'completed' OR status = 'failed'))",
            },
          ],
        };
      }
      return { rows: [] };
    });

    const db = new PostgresDatabase({
      pool: { on, query: vi.fn(), connect, end: vi.fn() } as never,
      logger,
    });

    await expect(db.migrate()).rejects.toBeInstanceOf(DatabaseError);
  });
});
