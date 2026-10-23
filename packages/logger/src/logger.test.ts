import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Logger, createLogger, LogLevel } from './index.js';
import type { LogEntry, LogTransport } from './index.js';

class MemoryTransport implements LogTransport {
  entries: LogEntry[] = [];
  write(entry: LogEntry): void {
    this.entries.push(entry);
  }
}

describe('Logger', () => {
  let transport: MemoryTransport;

  beforeEach(() => {
    transport = new MemoryTransport();
  });

  it('emits structured log entries at and above the configured level', () => {
    const logger = new Logger({ level: LogLevel.INFO, transport, service: 'test' });

    logger.debug('skipped');
    logger.info('hello', { userId: 1 });
    logger.warn('careful');

    expect(transport.entries).toHaveLength(2);
    expect(transport.entries[0]).toMatchObject({
      level: 'INFO',
      message: 'hello',
      service: 'test',
      context: { userId: 1 },
    });
    expect(transport.entries[0].timestamp).toBeDefined();
    expect(transport.entries[1].level).toBe('WARN');
  });

  it('serializes Error instances on error/fatal', () => {
    const logger = new Logger({ level: LogLevel.DEBUG, transport });
    const err = new Error('boom');

    logger.error('failed', { jobId: 'abc' }, err);

    expect(transport.entries[0].error).toMatchObject({
      name: 'Error',
      message: 'boom',
    });
    expect(transport.entries[0].error?.stack).toContain('boom');
    expect(transport.entries[0].context).toEqual({ jobId: 'abc' });
  });

  it('includes AppError-style details and the cause chain', () => {
    const logger = new Logger({ level: LogLevel.ERROR, transport });
    const root = Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' });
    const wrapped = Object.assign(new Error('Failed to store object k.jpg'), {
      name: 'StorageError',
      details: { key: 'k.jpg' },
      cause: root,
    });

    logger.error('put failed', {}, wrapped);

    expect(transport.entries[0].error).toMatchObject({
      name: 'StorageError',
      message: 'Failed to store object k.jpg',
      details: { key: 'k.jpg' },
      cause: {
        name: 'Error',
        message: 'EACCES: permission denied',
      },
    });
  });

  it('child logger inherits level and merges bindings', () => {
    const parent = new Logger({ level: LogLevel.DEBUG, transport, service: 'parent' });
    const child = parent.child({ requestId: 'r1', service: 'child' });

    child.info('nested');

    expect(transport.entries[0]).toMatchObject({
      service: 'child',
      context: { requestId: 'r1' },
      message: 'nested',
    });
  });

  it('setLevel changes the minimum emitted level', () => {
    const logger = new Logger({ level: LogLevel.ERROR, transport });
    logger.info('hidden');
    logger.setLevel(LogLevel.DEBUG);
    logger.info('visible');

    expect(transport.entries).toHaveLength(1);
    expect(transport.entries[0].message).toBe('visible');
  });

  it('accepts level by name string', () => {
    const logger = createLogger({ level: 'WARN', transport });
    logger.info('no');
    logger.warn('yes');
    expect(transport.entries).toHaveLength(1);
  });

  it('createLogger returns a working logger', () => {
    const write = vi.fn();
    const logger = createLogger({
      level: LogLevel.INFO,
      transport: { write },
      service: 'factory',
    });
    logger.info('ok');
    expect(write).toHaveBeenCalledOnce();
  });
});
