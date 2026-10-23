import { describe, it, expect, vi, beforeEach } from 'vitest';
import { VideoScanner } from './video-scanner.js';
import type { FileInfo, IFileSystem } from './types.js';

function file(path: string, isDirectory = false, size = 100, identity?: string): FileInfo {
  return {
    name: path.split('/').pop()!,
    path,
    permissions: 0o644,
    size,
    isDirectory,
    modifiedAt: new Date('2024-01-01'),
    identity: identity ?? path,
  };
}

describe('VideoScanner', () => {
  let fs: IFileSystem;
  let openFile: ReturnType<typeof vi.fn>;
  let listFiles: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    openFile = vi.fn();
    listFiles = vi.fn();
    fs = {
      openFile,
      listFiles,
      exists: vi.fn(),
    };
  });

  it('finds video files recursively and skips non-videos', async () => {
    openFile.mockImplementation(async (path: string) => {
      const dirs = new Set(['/root', '/root/a', '/root/a/b']);
      return file(path, dirs.has(path));
    });

    listFiles.mockImplementation(async (path: string) => {
      const tree: Record<string, string[]> = {
        '/root': ['/root/a', '/root/readme.txt', '/root/intro.mp4'],
        '/root/a': ['/root/a/b', '/root/a/clip.MOV'],
        '/root/a/b': ['/root/a/b/deep.mkv', '/root/a/b/notes.md'],
      };
      return tree[path] ?? [];
    });

    const scanner = new VideoScanner(fs);
    const videos = await scanner.findVideos('/root');

    expect(videos).toEqual(['/root/a/b/deep.mkv', '/root/a/clip.MOV', '/root/intro.mp4']);
  });

  it('respects maxDepth', async () => {
    openFile.mockImplementation(async (path: string) => {
      const dirs = new Set(['/root', '/root/nested']);
      return file(path, dirs.has(path));
    });
    listFiles.mockImplementation(async (path: string) => {
      if (path === '/root') return ['/root/top.mp4', '/root/nested'];
      if (path === '/root/nested') return ['/root/nested/deep.mp4'];
      return [];
    });

    const scanner = new VideoScanner(fs, { maxDepth: 0 });
    const videos = await scanner.findVideos('/root');

    expect(videos).toEqual(['/root/top.mp4']);
  });

  it('breaks symlink cycles via identity', async () => {
    openFile.mockImplementation(async (path: string) => {
      if (path === '/root') return file('/root', true, 0, 'id:root');
      if (path === '/root/loop') return file('/root/loop', true, 0, 'id:root'); // same inode as root
      return file(path, false, 100, path);
    });
    listFiles.mockImplementation(async (path: string) => {
      if (path === '/root') return ['/root/clip.mp4', '/root/loop'];
      if (path === '/root/loop') return ['/root/clip.mp4', '/root/loop'];
      return [];
    });

    const scanner = new VideoScanner(fs);
    const videos = await scanner.findVideos('/root');

    expect(videos).toEqual(['/root/clip.mp4']);
    expect(listFiles.mock.calls.length).toBe(1);
  });

  it('skips an unreadable subdirectory or a vanished file and keeps walking', async () => {
    const eacces = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    openFile.mockImplementation(async (path: string) => {
      if (path === '/root/gone.mp4') throw enoent;
      return file(path, path === '/root' || path === '/root/locked');
    });
    listFiles.mockImplementation(async (path: string) => {
      if (path === '/root') return ['/root/locked', '/root/gone.mp4', '/root/ok.mp4'];
      if (path === '/root/locked') throw eacces;
      return [];
    });
    const onSkip = vi.fn();

    const videos = await new VideoScanner(fs, { onSkip }).findVideos('/root');

    expect(videos).toEqual(['/root/ok.mp4']);
    expect(onSkip).toHaveBeenCalledWith('/root/locked', 'unreadable', eacces);
    expect(onSkip).toHaveBeenCalledWith('/root/gone.mp4', 'unreadable', enoent);
  });

  it('still rejects when the root itself cannot be read', async () => {
    openFile.mockResolvedValue(file('/root', true));
    listFiles.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    await expect(new VideoScanner(fs).findVideos('/root')).rejects.toThrow('EACCES');
  });

  it('skips entries whose real path resolves outside the root', async () => {
    const real: Record<string, string | undefined> = {
      '/root': '/real/root',
      '/root/in.mp4': '/real/root/in.mp4',
      '/root/escape': '/etc',
      '/root/sibling.mp4': '/real/root-sibling/x.mp4',
      '/root/unresolved.mp4': undefined,
    };
    openFile.mockImplementation(async (path: string) => ({
      ...file(path, path === '/root' || path === '/root/escape'),
      ...(real[path] ? { realPath: real[path] } : {}),
    }));
    listFiles.mockImplementation(async (path: string) =>
      path === '/root' ? Object.keys(real).filter((p) => p !== '/root') : ['/etc/secret.mp4'],
    );
    const onSkip = vi.fn();

    const videos = await new VideoScanner(fs, { onSkip }).findVideos('/root');

    expect(videos).toEqual(['/root/in.mp4']);
    expect(onSkip).toHaveBeenCalledWith('/root/escape', 'outside-root');
    expect(onSkip).toHaveBeenCalledWith('/root/sibling.mp4', 'outside-root');
    expect(onSkip).toHaveBeenCalledWith('/root/unresolved.mp4', 'unverifiable-path');
    expect(listFiles).toHaveBeenCalledTimes(1);
  });

  it('returns a single file when root is a video', async () => {
    openFile.mockResolvedValue(file('/movie.webm', false));
    const scanner = new VideoScanner(fs);
    await expect(scanner.findVideos('/movie.webm')).resolves.toEqual(['/movie.webm']);
    expect(listFiles).not.toHaveBeenCalled();
  });
});
