import { spawn, type ChildProcess } from 'node:child_process';
import { access } from 'node:fs/promises';
import { constants } from 'node:fs';
import type { IProcess, StartThumbnailProcess } from './thumbnail-process.js';

/** Total wall-clock budget for the whole FallbackSeekProcess (all seeks combined). */
export const DEFAULT_FFMPEG_TIMEOUT_MS = 120_000;
const DEFAULT_STDERR_LIMIT_BYTES = 64 * 1024;
const KILL_GRACE_MS = 5_000;
/** Seek offsets to try — 1s looks better on long clips; 0s works for short ones. */
const SEEK_SECONDS = ['1', '0'] as const;

export interface FfmpegProcessOptions {
  /** Total timeout for this process instance (ms). */
  timeoutMs?: number;
  stderrLimitBytes?: number;
  killGraceMs?: number;
}

/**
 * Real ffmpeg adapter used in local/dev/production when ffmpeg is installed.
 * Caps stderr by UTF-8 bytes, enforces a wall-clock timeout, escalates SIGTERM → SIGKILL.
 */
export class FfmpegProcess implements IProcess {
  private readonly stderrChunks: Buffer[] = [];
  private stderrBytes = 0;
  private stderrTruncated = false;
  private exitCode: number | null = null;
  private completed: Promise<number>;
  private readonly timeoutMs: number;
  private readonly stderrLimitBytes: number;
  private readonly killGraceMs: number;
  private settle!: (code: number) => void;
  private reject!: (error: Error) => void;
  private settled = false;

  constructor(
    private readonly child: ChildProcess,
    options: FfmpegProcessOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
    this.stderrLimitBytes = options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;

    if (this.child.stderr) {
      this.child.stderr.on('data', (chunk: string | Buffer) => {
        this.appendStderr(typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk);
      });
    }

    this.completed = new Promise<number>((resolve, reject) => {
      this.settle = (code) => {
        if (this.settled) return;
        this.settled = true;
        resolve(code);
      };
      this.reject = (error) => {
        if (this.settled) return;
        this.settled = true;
        reject(error);
      };
    });

    this.child.on('error', (error) => {
      this.reject(error);
    });
    this.child.on('close', (code) => {
      this.exitCode = code ?? 1;
      this.settle(this.exitCode);
    });
  }

  async kill(): Promise<void> {
    // ChildProcess.killed is true as soon as a signal is sent — not when it exits.
    // Gate on exitCode so SIGTERM that doesn't reap still escalates to SIGKILL.
    if (this.exitCode !== null) {
      return;
    }

    this.child.kill('SIGTERM');

    const exited = await Promise.race([
      this.completed.then(() => true),
      sleep(this.killGraceMs).then(() => false),
    ]);

    if (!exited && this.exitCode === null) {
      this.child.kill('SIGKILL');
      await Promise.race([this.completed, sleep(this.killGraceMs)]);
    }
  }

  async waitForCompletion(): Promise<number> {
    const timedOut = sleep(this.timeoutMs).then(() => 'timeout' as const);
    const result = await Promise.race([
      this.completed.then((code) => ({ type: 'done' as const, code })),
      timedOut,
    ]);

    if (result === 'timeout') {
      await this.kill();
      throw new Error(`ffmpeg timed out after ${this.timeoutMs}ms`);
    }

    return result.code;
  }

  getStderr(): string {
    const text = Buffer.concat(this.stderrChunks).toString('utf8');
    return this.stderrTruncated
      ? `${text}\n…[stderr truncated at ${this.stderrLimitBytes} bytes]`
      : text;
  }

  getExitCode(): number | null {
    return this.exitCode;
  }

  private appendStderr(chunk: Buffer): void {
    if (this.stderrTruncated || chunk.length === 0) {
      return;
    }
    const remaining = this.stderrLimitBytes - this.stderrBytes;
    if (remaining <= 0) {
      this.stderrTruncated = true;
      return;
    }
    if (chunk.length <= remaining) {
      this.stderrChunks.push(chunk);
      this.stderrBytes += chunk.length;
      return;
    }
    this.stderrChunks.push(chunk.subarray(0, remaining));
    this.stderrBytes += remaining;
    this.stderrTruncated = true;
  }
}

/**
 * Tries multiple seek offsets under a single shared timeout budget
 * so total runtime stays within BullMQ lockDuration.
 */
export class FallbackSeekProcess implements IProcess {
  private active: IProcess | null = null;
  private stderr = '';
  private readonly totalTimeoutMs: number;
  private readonly killGraceMs: number;
  private readonly stderrLimitBytes: number;

  constructor(
    private readonly videoPath: string,
    private readonly outputPath: string,
    options: FfmpegProcessOptions = {},
  ) {
    this.totalTimeoutMs = options.timeoutMs ?? DEFAULT_FFMPEG_TIMEOUT_MS;
    this.killGraceMs = options.killGraceMs ?? KILL_GRACE_MS;
    this.stderrLimitBytes = options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES;
  }

  async kill(): Promise<void> {
    if (this.active) {
      await this.active.kill();
    }
  }

  async waitForCompletion(): Promise<number> {
    const deadline = Date.now() + this.totalTimeoutMs;
    let lastCode = 1;

    for (let i = 0; i < SEEK_SECONDS.length; i += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw new Error(`ffmpeg timed out after ${this.totalTimeoutMs}ms`);
      }

      const seek = SEEK_SECONDS[i]!;
      this.active = spawnFfmpeg(this.videoPath, this.outputPath, seek, {
        timeoutMs: remaining,
        killGraceMs: this.killGraceMs,
        stderrLimitBytes: this.stderrLimitBytes,
      });

      try {
        lastCode = await this.active.waitForCompletion();
      } catch (error) {
        this.stderr = this.active.getStderr();
        if (i === SEEK_SECONDS.length - 1 || Date.now() >= deadline) {
          throw error;
        }
        continue;
      }

      this.stderr = this.active.getStderr();

      if (lastCode === 0 && (await fileExists(this.outputPath))) {
        return 0;
      }

      if (i < SEEK_SECONDS.length - 1) {
        await this.active.kill();
      }
    }

    return lastCode;
  }

  getStderr(): string {
    return this.stderr || (this.active?.getStderr() ?? '');
  }
}

export function createFfmpegStarter(options: FfmpegProcessOptions = {}): StartThumbnailProcess {
  return (videoPath, outputPath) => new FallbackSeekProcess(videoPath, outputPath, options);
}

function spawnFfmpeg(
  videoPath: string,
  outputPath: string,
  seekSeconds: string,
  options: FfmpegProcessOptions,
): FfmpegProcess {
  const child = spawn(
    'ffmpeg',
    [
      '-hide_banner',
      '-y',
      '-ss',
      seekSeconds,
      '-i',
      videoPath,
      '-frames:v',
      '1',
      '-q:v',
      '2',
      outputPath,
    ],
    { stdio: ['ignore', 'ignore', 'pipe'] },
  );

  return new FfmpegProcess(child, options);
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
