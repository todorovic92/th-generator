import type { LogEntry, LogTransport } from './types.js';
import { LogLevel } from './types.js';

const STDERR_LEVELS = new Set<string>(['ERROR', 'FATAL']);

export class ConsoleTransport implements LogTransport {
  write(entry: LogEntry): void {
    const line = JSON.stringify(entry);
    if (STDERR_LEVELS.has(entry.level)) {
      process.stderr.write(line + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }
}

export function resolveLevel(level: LogLevel | keyof typeof LogLevel): LogLevel {
  if (typeof level === 'number') {
    return level;
  }
  const resolved = LogLevel[level];
  if (resolved === undefined) {
    throw new Error(`Unknown log level: ${level}`);
  }
  return resolved;
}
