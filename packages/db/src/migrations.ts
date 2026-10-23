/**
 * Versioned, ordered migrations.
 * Each entry runs once and is recorded in schema_migrations.
 * Never edit an applied migration — append a new one instead.
 *
 * Use plain CREATE TABLE (not IF NOT EXISTS) so a wrong-shaped pre-existing
 * table fails loudly instead of being silently marked applied.
 */
export interface Migration {
  id: string;
  sql: string;
}

export interface ExpectedColumn {
  name: string;
  /** information_schema.data_type */
  dataType: string;
  /** information_schema.udt_name (more precise for uuid/timestamptz) */
  udtName: string;
}

export const REQUIRED_THUMBNAIL_COLUMNS: readonly ExpectedColumn[] = [
  { name: 'id', dataType: 'uuid', udtName: 'uuid' },
  { name: 'video_path', dataType: 'text', udtName: 'text' },
  { name: 'thumbnail_key', dataType: 'text', udtName: 'text' },
  { name: 'location', dataType: 'text', udtName: 'text' },
  { name: 'size_bytes', dataType: 'bigint', udtName: 'int8' },
  { name: 'content_type', dataType: 'text', udtName: 'text' },
  { name: 'status', dataType: 'text', udtName: 'text' },
  { name: 'correlation_id', dataType: 'text', udtName: 'text' },
  { name: 'duration_ms', dataType: 'integer', udtName: 'int4' },
  { name: 'video_size_bytes', dataType: 'bigint', udtName: 'int8' },
  { name: 'error_message', dataType: 'text', udtName: 'text' },
  { name: 'created_at', dataType: 'timestamp with time zone', udtName: 'timestamptz' },
  { name: 'updated_at', dataType: 'timestamp with time zone', udtName: 'timestamptz' },
] as const;

export const REQUIRED_THUMBNAIL_COLUMN_NAMES = REQUIRED_THUMBNAIL_COLUMNS.map((c) => c.name);

export const MIGRATIONS: Migration[] = [
  {
    id: '001_init_thumbnails',
    sql: `
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TABLE thumbnails (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  video_path      TEXT NOT NULL,
  thumbnail_key   TEXT NOT NULL,
  location        TEXT NOT NULL,
  size_bytes      BIGINT NOT NULL DEFAULT 0,
  content_type    TEXT NOT NULL DEFAULT 'image/jpeg',
  status          TEXT NOT NULL CHECK (status IN ('completed', 'failed')),
  correlation_id  TEXT,
  duration_ms     INTEGER,
  video_size_bytes BIGINT,
  error_message   TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT thumbnails_video_path_unique UNIQUE (video_path)
);

CREATE INDEX IF NOT EXISTS idx_thumbnails_thumbnail_key ON thumbnails (thumbnail_key);
CREATE INDEX IF NOT EXISTS idx_thumbnails_status ON thumbnails (status);
CREATE INDEX IF NOT EXISTS idx_thumbnails_created_at ON thumbnails (created_at DESC);
`,
  },
];

export const SCHEMA_MIGRATIONS_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
  id          TEXT PRIMARY KEY,
  applied_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;

export const VERIFY_THUMBNAILS_COLUMNS_SQL = `
SELECT column_name, data_type, udt_name
FROM information_schema.columns
WHERE table_schema = 'public' AND table_name = 'thumbnails'
`;

export const VERIFY_THUMBNAILS_CONSTRAINTS_SQL = `
SELECT c.conname AS name, c.contype AS type, pg_get_constraintdef(c.oid) AS definition
FROM pg_constraint c
JOIN pg_class t ON c.conrelid = t.oid
JOIN pg_namespace n ON n.oid = t.relnamespace
WHERE n.nspname = 'public' AND t.relname = 'thumbnails' AND c.contype IN ('u', 'c', 'p')
`;
