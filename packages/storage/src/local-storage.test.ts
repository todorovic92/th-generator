import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtemp,
  writeFile,
  rm,
  readFile,
  chmod,
  lstat,
  readdir,
  symlink,
  utimes,
} from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LocalObjectStorage } from './local-storage.js';
import { buildThumbnailKey } from './key-builder.js';
import { StorageError } from './errors.js';

describe('LocalObjectStorage', () => {
  let rootDir: string;
  let storage: LocalObjectStorage;
  let sourcePath: string;

  beforeEach(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'tg-storage-'));
    storage = new LocalObjectStorage({ rootDir });
    sourcePath = join(rootDir, 'source.jpg');
    await writeFile(sourcePath, 'fake-image');
  });

  afterEach(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  it('puts, locates, stats, and checks existence of objects', async () => {
    const stored = await storage.putObject({
      key: 'demo.jpg',
      sourcePath,
      contentType: 'image/jpeg',
    });

    expect(stored.key).toBe('demo.jpg');
    expect(stored.location).toBe(storage.getLocation('demo.jpg'));
    expect(stored.location.endsWith('/demo.jpg')).toBe(true);
    expect(stored.size).toBe(10);
    expect(await storage.exists('demo.jpg')).toBe(true);
    expect(await storage.statObject('demo.jpg')).toEqual({
      key: 'demo.jpg',
      location: stored.location,
      size: 10,
    });
    expect(await readFile(stored.location, 'utf8')).toBe('fake-image');
  });

  it('rejects path-traversal keys', async () => {
    await expect(storage.putObject({ key: '../escape.jpg', sourcePath })).rejects.toBeInstanceOf(
      StorageError,
    );
    await expect(storage.exists('../../etc/passwd')).rejects.toBeInstanceOf(StorageError);
  });

  it('rejects nested keys instead of aliasing them onto flat names', async () => {
    for (const key of ['a/b.jpg', 'a\\b.jpg', '/abs.jpg', '.hidden', '..', '', 'x'.repeat(256)]) {
      await expect(storage.putObject({ key, sourcePath })).rejects.toBeInstanceOf(StorageError);
      await expect(storage.exists(key)).rejects.toBeInstanceOf(StorageError);
    }
    const stored = await storage.putObject({ key: 'a__b.jpg', sourcePath });
    expect(stored.location.endsWith('/a__b.jpg')).toBe(true);
  });

  it('accepts every key buildThumbnailKey produces', async () => {
    for (const videoPath of ['/v/clip.mp4', '/v/Ünïcode name (1).mkv', '/v/.hidden', '/v/noext']) {
      const key = buildThumbnailKey(videoPath);
      await expect(storage.putObject({ key, sourcePath })).resolves.toMatchObject({ key });
    }
  });

  it('removes only staging files older than the threshold', async () => {
    const stale = join(rootDir, '.tg-staging-stale.tmp');
    const fresh = join(rootDir, '.tg-staging-fresh.tmp');
    await writeFile(stale, 'x');
    await writeFile(fresh, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);
    await storage.putObject({ key: 'kept.jpg', sourcePath });

    expect(await storage.removeStaleStagingFiles()).toEqual({ removed: 1, failed: [] });
    const names = await readdir(rootDir);
    expect(names).not.toContain('.tg-staging-stale.tmp');
    expect(names).toContain('.tg-staging-fresh.tmp');
    expect(names).toContain('kept.jpg');
  });

  it('reports undeletable staging files instead of throwing', async () => {
    const stale = join(rootDir, '.tg-staging-stuck.tmp');
    await writeFile(stale, 'x');
    const old = new Date(Date.now() - 2 * 60 * 60 * 1000);
    await utimes(stale, old, old);

    await chmod(rootDir, 0o555);
    try {
      expect(await storage.removeStaleStagingFiles()).toEqual({
        removed: 0,
        failed: [{ path: join(realpathSync(rootDir), '.tg-staging-stuck.tmp'), code: 'EACCES' }],
      });
    } finally {
      await chmod(rootDir, 0o755);
    }
  });

  it('reports an unreadable root instead of throwing', async () => {
    await chmod(rootDir, 0o000);
    try {
      const result = await storage.removeStaleStagingFiles();
      expect(result.removed).toBe(0);
      expect(result.failed).toEqual([{ path: expect.any(String), code: 'EACCES' }]);
    } finally {
      await chmod(rootDir, 0o755);
    }
  });

  it('deletes objects and ignores missing keys', async () => {
    await storage.putObject({ key: 'a.jpg', sourcePath });
    await storage.deleteObject('a.jpg');
    expect(await storage.exists('a.jpg')).toBe(false);
    await expect(storage.deleteObject('missing.jpg')).resolves.toBeUndefined();
  });

  it('creates objects with mode 0644 and leaves no staging files behind', async () => {
    const stored = await storage.putObject({ key: 'mode.jpg', sourcePath });
    expect((await lstat(stored.location)).mode & 0o777).toBe(0o644 & ~process.umask());
    expect((await readdir(rootDir)).filter((name) => name.startsWith('.tg-staging-'))).toEqual([]);
  });

  it('never follows a symlink at the object path', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'tg-outside-'));
    const target = join(outside, 'victim.jpg');
    await writeFile(target, 'outside-bytes');
    const location = storage.getLocation('linked.jpg');
    try {
      await symlink(target, location);

      expect(await storage.exists('linked.jpg')).toBe(false);
      expect(await storage.statObject('linked.jpg')).toBeNull();

      await storage.deleteObject('linked.jpg');
      expect(await readFile(target, 'utf8')).toBe('outside-bytes');

      await symlink(target, location);
      await storage.putObject({ key: 'linked.jpg', sourcePath });
      expect(await readFile(target, 'utf8')).toBe('outside-bytes');
      expect((await lstat(location)).isFile()).toBe(true);
      expect(await readFile(location, 'utf8')).toBe('fake-image');
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });

  it('rejects keys that collide with the staging namespace', async () => {
    await expect(
      storage.putObject({ key: '.tg-staging-x.tmp', sourcePath }),
    ).rejects.toBeInstanceOf(StorageError);
  });

  it('surfaces EACCES as an ErrnoException code in the cause chain', async () => {
    await chmod(rootDir, 0o555);
    try {
      const error = await storage.putObject({ key: 'denied.jpg', sourcePath }).then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(StorageError);
      expect(((error as Error).cause as NodeJS.ErrnoException).code).toBe('EACCES');
    } finally {
      await chmod(rootDir, 0o755);
    }
  });

  it('does not map non-ENOENT errors to missing', async () => {
    await storage.putObject({ key: 'a.jpg', sourcePath });
    const realRoot = join(storage.getLocation('a.jpg'), '..');
    await chmod(realRoot, 0o000);

    try {
      await expect(storage.exists('a.jpg')).rejects.toBeInstanceOf(StorageError);
    } finally {
      await chmod(realRoot, 0o755);
    }
  });
});

describe('buildThumbnailKey', () => {
  it('produces stable keys for the same path', () => {
    const a = buildThumbnailKey('/videos/clip.mp4');
    const b = buildThumbnailKey('/videos/clip.mp4');
    expect(a).toBe(b);
    expect(a).toMatch(/^clip-[a-f0-9]{16}\.jpg$/);
  });

  it('differs for different paths with the same basename', () => {
    const a = buildThumbnailKey('/a/clip.mp4');
    const b = buildThumbnailKey('/b/clip.mp4');
    expect(a).not.toBe(b);
  });
});
