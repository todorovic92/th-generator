/**
 * Abstract file system interface from the assessment.
 * Implementations may wrap local POSIX FS, network mounts, or remote FS APIs.
 */
export interface FileInfo {
  name: string;
  path: string;
  permissions: number;
  size: number;
  isDirectory: boolean;
  modifiedAt: Date;
  /**
   * Stable identity for cycle detection (e.g. "dev:ino" or a resolved real path).
   * Optional so remote FS adapters can omit it; scanners then fall back to path.
   */
  identity?: string;
  /**
   * Fully resolved path (all symlinks followed). Used to keep walks inside their root.
   * Adapters that cannot resolve symlinks omit it and must enforce containment themselves.
   */
  realPath?: string;
}

export interface IFileSystem {
  /** Return a list of file paths directly under the given path (non-recursive). */
  listFiles(path: string): Promise<string[]>;

  /**
   * Returns metadata about the given file or directory.
   * Throws PathNotFoundError only when the path is definitively absent;
   * any other failure is a (retryable) FileSystemError.
   */
  openFile(path: string): Promise<FileInfo>;

  /** Whether a path exists. False only for a genuine absence; other failures throw. */
  exists(path: string): Promise<boolean>;
}

/**
 * Recursive video discovery built on top of IFileSystem.
 * Kept as a separate collaborator so scanning logic is easy to unit-test.
 */
export interface IVideoScanner {
  findVideos(rootPath: string): Promise<string[]>;
}
