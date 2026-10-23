import type { IVideoScanner } from '@thumbnail-generator/filesystem';
import type { ILogger } from '@thumbnail-generator/logger';
import type { IJobPublisher } from './job-publisher.js';

export interface ScanResult {
  videosFound: number;
  enqueued: number;
  skipped: number;
  durationMs: number;
}

/**
 * Orchestrates one scan cycle: discover videos → publish jobs.
 * Pure collaboration of injected dependencies — no framework DI needed.
 */
export class ScanService {
  constructor(
    private readonly videoScanner: IVideoScanner,
    private readonly publisher: IJobPublisher,
    private readonly logger: ILogger,
    private readonly scanPath: string,
  ) {}

  async runOnce(): Promise<ScanResult> {
    const started = Date.now();
    this.logger.info('Starting filesystem scan', { scanPath: this.scanPath });

    try {
      const videos = await this.videoScanner.findVideos(this.scanPath);
      this.logger.info('Scan discovered videos', { count: videos.length });

      const { enqueued, skipped } = await this.publisher.publishThumbnailJobs(videos);
      const result: ScanResult = {
        videosFound: videos.length,
        enqueued,
        skipped,
        durationMs: Date.now() - started,
      };

      this.logger.info('Scan cycle complete', { ...result });
      return result;
    } catch (error) {
      this.logger.error('Scan cycle failed', { scanPath: this.scanPath }, error);
      throw error;
    }
  }
}
