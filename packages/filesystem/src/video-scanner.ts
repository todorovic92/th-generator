import { sep } from 'node:path';
import { isVideoFile } from './video-extensions.js';
import type { FileInfo, IFileSystem, IVideoScanner } from './types.js';

/** Safety cap when callers do not set maxDepth (avoids runaway walks). */
export const DEFAULT_MAX_DEPTH = 64;

export type ScanSkipReason = 'unreadable' | 'outside-root' | 'unverifiable-path';

export interface VideoScannerOptions {
  /** Max directory depth. Defaults to {@link DEFAULT_MAX_DEPTH}. */
  maxDepth?: number;
  /** Called for every entry the walk skips; the walk itself continues. */
  onSkip?: (path: string, reason: ScanSkipReason, error?: unknown) => void;
}

/**
 * Walks an IFileSystem tree and collects video file paths.
 * - Tracks FileInfo.identity (or path) to break symlink / hardlink cycles.
 * - When the adapter reports realPath, entries resolving outside the root's
 *   realPath are skipped, so a symlink cannot lead the walk out of the scan root.
 * - A failure on one entry (EACCES, deleted mid-walk) skips that entry only.
 *   Only a failure on the root itself rejects.
 */
export class VideoScanner implements IVideoScanner {
  private readonly maxDepth: number;
  private readonly onSkip: NonNullable<VideoScannerOptions['onSkip']>;

  constructor(
    private readonly fs: IFileSystem,
    options: VideoScannerOptions = {},
  ) {
    this.maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    this.onSkip = options.onSkip ?? (() => undefined);
  }

  async findVideos(rootPath: string): Promise<string[]> {
    const rootInfo = await this.fs.openFile(rootPath);
    const walk: WalkState = {
      rootRealPath: rootInfo.realPath,
      videos: [],
      visited: new Set<string>(),
    };
    await this.visit(rootPath, rootInfo, 0, walk);
    return walk.videos.sort();
  }

  private async visit(
    currentPath: string,
    info: FileInfo,
    depth: number,
    walk: WalkState,
  ): Promise<void> {
    const identity = info.identity ?? currentPath;
    if (walk.visited.has(identity)) {
      return;
    }
    walk.visited.add(identity);

    if (!info.isDirectory) {
      if (isVideoFile(currentPath)) {
        walk.videos.push(currentPath);
      }
      return;
    }

    if (depth > this.maxDepth) {
      return;
    }

    let children: string[];
    try {
      children = await this.fs.listFiles(currentPath);
    } catch (error) {
      if (depth === 0) {
        throw error;
      }
      this.onSkip(currentPath, 'unreadable', error);
      return;
    }

    for (const child of children) {
      let childInfo: FileInfo;
      try {
        childInfo = await this.fs.openFile(child);
      } catch (error) {
        this.onSkip(child, 'unreadable', error);
        continue;
      }

      if (walk.rootRealPath !== undefined) {
        if (childInfo.realPath === undefined) {
          this.onSkip(child, 'unverifiable-path');
          continue;
        }
        if (!isInside(walk.rootRealPath, childInfo.realPath)) {
          this.onSkip(child, 'outside-root');
          continue;
        }
      }

      await this.visit(child, childInfo, depth + 1, walk);
    }
  }
}

interface WalkState {
  rootRealPath: string | undefined;
  videos: string[];
  visited: Set<string>;
}

function isInside(root: string, candidate: string): boolean {
  if (candidate === root) {
    return true;
  }
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}
