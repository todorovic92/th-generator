import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { describe, it, expect } from 'vitest';
import { FfmpegProcess } from './ffmpeg-adapter.js';

function hungChild(): { child: ChildProcess; signals: string[] } {
  const signals: string[] = [];
  const emitter = new EventEmitter() as EventEmitter & {
    killed: boolean;
    kill: (signal?: NodeJS.Signals | number) => boolean;
    stderr: null;
  };
  emitter.killed = false;
  emitter.stderr = null;
  emitter.kill = (signal = 'SIGTERM') => {
    // Node sets .killed as soon as a signal is sent, even if the process is still running.
    emitter.killed = true;
    signals.push(String(signal));
    if (signal === 'SIGKILL') {
      queueMicrotask(() => emitter.emit('close', 137));
    }
    return true;
  };
  return { child: emitter as unknown as ChildProcess, signals };
}

describe('FfmpegProcess.kill', () => {
  it('escalates SIGTERM to SIGKILL when the child stays alive', async () => {
    const { child, signals } = hungChild();
    const proc = new FfmpegProcess(child, { timeoutMs: 30, killGraceMs: 20 });

    await expect(proc.waitForCompletion()).rejects.toThrow(/timed out after 30ms/);
    expect(signals).toEqual(['SIGTERM', 'SIGKILL']);
    expect(proc.getExitCode()).toBe(137);
  });

  it('does not send SIGKILL if SIGTERM reaps the child', async () => {
    const { child, signals } = hungChild();
    child.kill = (signal = 'SIGTERM') => {
      (child as unknown as { killed: boolean }).killed = true;
      signals.push(String(signal));
      queueMicrotask(() => child.emit('close', 143));
      return true;
    };
    const proc = new FfmpegProcess(child, { timeoutMs: 30, killGraceMs: 40 });

    await expect(proc.waitForCompletion()).rejects.toThrow(/timed out/);
    expect(signals).toEqual(['SIGTERM']);
    expect(proc.getExitCode()).toBe(143);
  });
});
