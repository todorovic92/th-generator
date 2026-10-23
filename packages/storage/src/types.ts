/**
 * Object-store style abstraction.
 * Local FS today; swap to S3/GCS by implementing this interface.
 */
export interface PutObjectInput {
  /** Logical key, e.g. "clip-abc123.jpg". */
  key: string;
  /** Absolute path of a local temp file to upload/copy. */
  sourcePath: string;
  contentType?: string;
}

export interface StoredObject {
  key: string;
  /** Backend-specific locator (local path, s3:// URI, etc.). */
  location: string;
  size: number;
}

export interface ObjectStat {
  key: string;
  location: string;
  size: number;
}

export interface IObjectStorage {
  putObject(input: PutObjectInput): Promise<StoredObject>;
  exists(key: string): Promise<boolean>;
  /** Returns size/location when the object exists; null otherwise. */
  statObject(key: string): Promise<ObjectStat | null>;
  deleteObject(key: string): Promise<void>;
  getLocation(key: string): string;
}
