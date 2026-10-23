import { randomUUID } from 'node:crypto';

/** Atomic compare-and-delete so we never DEL another publisher's lock after TTL expiry. */
export const RELEASE_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("del", KEYS[1])
end
return 0
`;

/** Atomic compare-and-expire to renew ownership. */
export const RENEW_LOCK_LUA = `
if redis.call("get", KEYS[1]) == ARGV[1] then
  return redis.call("expire", KEYS[1], ARGV[2])
end
return 0
`;

export function publishLockKey(jobId: string): string {
  return `tg:publish-lock:${jobId}`;
}

export class PublishLockLostError extends Error {
  constructor(jobId: string) {
    super(`Publish lock lost for job ${jobId}`);
    this.name = 'PublishLockLostError';
  }
}

export interface RedisLockClient {
  set(
    key: string,
    value: string,
    expiryMode: 'EX',
    ttlSeconds: number,
    setMode: 'NX',
  ): Promise<unknown>;
  eval(script: string, numKeys: number, key: string, token: string, ttl?: string): Promise<unknown>;
}

export interface LockWarnLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/**
 * Per-jobId Redis lock (SET NX EX + Lua compare-and-expire / compare-and-delete).
 * Isolated so the Lua can be tested against a real Redis without BullMQ.
 */
export class PublishLock {
  constructor(
    private readonly getClient: () => Promise<RedisLockClient>,
    private readonly ttlSeconds: number,
    private readonly logger?: LockWarnLogger,
  ) {}

  async acquire(jobId: string): Promise<{ token: string } | null> {
    const redis = await this.getClient();
    const token = randomUUID();
    const result = await redis.set(publishLockKey(jobId), token, 'EX', this.ttlSeconds, 'NX');
    return result === 'OK' ? { token } : null;
  }

  async renew(jobId: string, token: string): Promise<boolean> {
    const redis = await this.getClient();
    const result = await redis.eval(
      RENEW_LOCK_LUA,
      1,
      publishLockKey(jobId),
      token,
      String(this.ttlSeconds),
    );
    return result === 1;
  }

  async release(jobId: string, token: string): Promise<void> {
    const redis = await this.getClient();
    await redis.eval(RELEASE_LOCK_LUA, 1, publishLockKey(jobId), token);
  }

  /**
   * Renew (extend TTL) if we still own the lock. Pure GET-then-act leaves a TTL gap;
   * renew is compare-and-expire in one Redis round-trip.
   */
  async assertHeld(jobId: string, token: string, lockState: { lost: boolean }): Promise<void> {
    if (lockState.lost) {
      throw new PublishLockLostError(jobId);
    }
    const renewed = await this.renew(jobId, token);
    if (!renewed) {
      lockState.lost = true;
      throw new PublishLockLostError(jobId);
    }
  }

  startRenewal(jobId: string, token: string, onLost: () => void): () => void {
    const intervalMs = Math.max(1_000, Math.floor((this.ttlSeconds * 1000) / 3));
    const handle = setInterval(() => {
      void this.renew(jobId, token)
        .then((renewed) => {
          if (!renewed) {
            onLost();
            this.logger?.warn('Publish lock renew returned 0 — lock lost', { jobId });
          }
        })
        .catch((error: unknown) => {
          onLost();
          this.logger?.warn('Failed to renew publish lock', { jobId, error: String(error) });
        });
    }, intervalMs);
    handle.unref?.();
    return () => clearInterval(handle);
  }
}
