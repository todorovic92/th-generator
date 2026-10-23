import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { isRetryableError } from '@thumbnail-generator/errors';
import { LocalFileSystem } from './local-filesystem.js';
import { VideoScanner } from './video-scanner.js';
import { FileSystemError, PathNotFoundError } from './errors.js';

describe('LocalFileSystem', () => {
  let root: string;
  let fs: LocalFileSystem;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tg-fs-'));
    fs = new LocalFileSystem();
    await mkdir(join(root, 'sub'));
    await writeFile(join(root, 'a.txt'), 'hello');
    await writeFile(join(root, 'sub', 'b.txt'), 'world');
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('lists files and opens metadata', async () => {
    const listed = await fs.listFiles(root);
    expect(listed.sort()).toEqual([join(root, 'a.txt'), join(root, 'sub')].sort());

    const info = await fs.openFile(join(root, 'a.txt'));
    expect(info.isDirectory).toBe(false);
    expect(info.size).toBe(5);
    expect(info.name).toBe('a.txt');

    expect(await fs.exists(join(root, 'a.txt'))).toBe(true);
    expect(await fs.exists(join(root, 'nope'))).toBe(false);
  });

  it('reports a genuinely missing path as PathNotFoundError (non-retryable)', async () => {
    for (const missing of [join(root, 'nope'), join(root, 'a.txt', 'child')]) {
      const error = await fs.openFile(missing).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(PathNotFoundError);
      expect(isRetryableError(error)).toBe(false);
    }
    await expect(fs.listFiles(join(root, 'missing'))).rejects.toBeInstanceOf(PathNotFoundError);
  });

  it('walks a real tree without escaping via symlinks or aborting on EACCES', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tg-outside-'));
    const scanRoot = join(root, 'videos');
    try {
      await writeFile(join(outside, 'secret.mp4'), 'x');
      await mkdir(join(scanRoot, 'locked'), { recursive: true });
      await writeFile(join(scanRoot, 'locked', 'hidden.mp4'), 'x');
      await writeFile(join(scanRoot, 'clip.mp4'), 'x');
      await symlink(outside, join(scanRoot, 'escape-dir'));
      await symlink(join(outside, 'secret.mp4'), join(scanRoot, 'escape.mp4'));
      await symlink(join(scanRoot, 'clip.mp4'), join(scanRoot, 'alias.mp4'));
      await chmod(join(scanRoot, 'locked'), 0o000);

      const skipped: Array<[string, string]> = [];
      const scanner = new VideoScanner(fs, {
        onSkip: (path, reason) => skipped.push([path, reason]),
      });
      const videos = await scanner.findVideos(scanRoot);

      expect(videos).toHaveLength(1);
      expect(['clip.mp4', 'alias.mp4']).toContain(basename(videos[0]!));
      expect(skipped).toEqual(
        expect.arrayContaining([
          [join(scanRoot, 'escape-dir'), 'outside-root'],
          [join(scanRoot, 'escape.mp4'), 'outside-root'],
          [join(scanRoot, 'locked'), 'unreadable'],
        ]),
      );
    } finally {
      await chmod(join(scanRoot, 'locked'), 0o755).catch(() => undefined);
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('keeps permission errors retryable and never reports them as missing', async () => {
    const locked = join(root, 'locked');
    await mkdir(locked);
    await writeFile(join(locked, 'clip.mp4'), 'x');
    await chmod(locked, 0o000);
    try {
      const error = await fs.openFile(join(locked, 'clip.mp4')).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(FileSystemError);
      expect(error).not.toBeInstanceOf(PathNotFoundError);
      expect(isRetryableError(error)).toBe(true);
      expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('EACCES');

      await expect(fs.exists(join(locked, 'clip.mp4'))).rejects.toBeInstanceOf(FileSystemError);
    } finally {
      await chmod(locked, 0o755);
    }
  });
});
