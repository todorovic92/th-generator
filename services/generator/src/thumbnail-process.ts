/**
 * Assessment-provided process abstraction for ffmpeg thumbnail generation.
 * Production supplies a real implementation; we provide a local adapter + test doubles.
 */
export interface IProcess {
  /**
   * Terminates the process (SIGTERM, then SIGKILL after grace period).
   * Returns a promise that settles when the process has exited or kill timed out.
   */
  kill(): Promise<void>;
  /**
   * Blocks until the process finishes and returns its status code.
   * Rejects on spawn failure or timeout (implementation-defined).
   */
  waitForCompletion(): Promise<number>;
  /** Returns the stderr output from the process (available after completion). */
  getStderr(): string;
}

/**
 * Starts an ffmpeg process to generate a thumbnail for the given video.
 * Declared as a function type so it can be injected / mocked easily.
 */
export type StartThumbnailProcess = (videoPath: string, outputPath: string) => IProcess;
