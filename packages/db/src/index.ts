export type {
  ThumbnailStatus,
  ThumbnailRecord,
  UpsertThumbnailInput,
  IThumbnailRepository,
  IDatabase,
} from './types.js';

export {
  MIGRATIONS,
  SCHEMA_MIGRATIONS_DDL,
  REQUIRED_THUMBNAIL_COLUMNS,
  REQUIRED_THUMBNAIL_COLUMN_NAMES,
  VERIFY_THUMBNAILS_COLUMNS_SQL,
  VERIFY_THUMBNAILS_CONSTRAINTS_SQL,
  type Migration,
  type ExpectedColumn,
} from './migrations.js';
export { mapThumbnailRow, toSafeInteger, type ThumbnailRow } from './mappers.js';
export { PostgresThumbnailRepository } from './postgres-thumbnail-repository.js';
export {
  PostgresDatabase,
  createPostgresDatabase,
  isUniqueOnVideoPathOnly,
  isStatusCheckConstraint,
  MIGRATE_ADVISORY_LOCK_KEY,
  type PostgresDatabaseOptions,
} from './postgres-database.js';

export { InMemoryThumbnailRepository } from './memory-thumbnail-repository.js';
export { DatabaseError } from './errors.js';
