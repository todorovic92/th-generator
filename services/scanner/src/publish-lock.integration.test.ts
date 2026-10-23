import { randomUUID } from 'node:crypto';
import { describe, it, expect, afterAll } from 'vitest';
import Redis from 'ioredis';
import { PublishLock, publishLockKey } from './publish-lock.js';

const required = process.env.CI === 'true' || process.env.RUN_INTEGRATION === 'true';

async function connectRedis(): Promise<Redis> {
  const host = process.env.REDIS_HOST ?? '127.0.0.1';
  const port = Number(process.env.REDIS_PORT ?? '6379');
  const password = process.env.REDIS_PASSWORD || undefined;
  const redis = new Redis({
    host,
    port,
    ...(password ? { password } : {}),
    lazyConnect: true,
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
  });
  try {
    await redis.connect();
    await redis.ping();
    return redis;
  } catch (error) {
    redis.disconnect();
    throw new Error(`Redis at ${host}:${port} is required for integration tests`, { cause: error });
  }
}

const redis = required ? await connectRedis() : undefined;

afterAll(() => {
  redis?.disconnect();
});

describe.skipIf(!required)('PublishLock against Redis', () => {
  it('SET NX grants one owner; the other acquire fails', async () => {
    const lock = new PublishLock(async () => redis!, 10);
    const jobId = `it-${randomUUID()}`;
    const first = await lock.acquire(jobId);
    const second = await lock.acquire(jobId);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    await lock.release(jobId, first!.token);
  });

  it('renew and release compare the token, so a stale owner cannot steal', async () => {
    const lock = new PublishLock(async () => redis!, 10);
    const jobId = `it-${randomUUID()}`;
    const held = await lock.acquire(jobId);
    expect(held).not.toBeNull();

    expect(await lock.renew(jobId, 'not-the-token')).toBe(false);
    expect(await lock.renew(jobId, held!.token)).toBe(true);
    expect(await redis!.get(publishLockKey(jobId))).toBe(held!.token);

    await lock.release(jobId, 'not-the-token');
    expect(await redis!.get(publishLockKey(jobId))).toBe(held!.token);

    await lock.release(jobId, held!.token);
    expect(await redis!.get(publishLockKey(jobId))).toBeNull();
  });
});
