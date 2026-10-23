import { ConsoleTransport, resolveLevel } from './console-transport.js';
import {
  type ILogger,
  type LogContext,
  type LogEntry,
  LogLevel,
  type LogLevelName,
  type LoggerOptions,
  type LogTransport,
} from './types.js';

const MAX_CAUSE_DEPTH = 5;

function serializeError(error: unknown, depth = 0, seen = new Set<unknown>()): LogEntry['error'] {
  if (error instanceof Error) {
    if (seen.has(error) || depth > MAX_CAUSE_DEPTH) {
      return { name: error.name, message: '[circular cause]' };
    }
    seen.add(error);
    const details = errorDetails(error);
    const cause =
      error.cause !== undefined ? serializeError(error.cause, depth + 1, seen) : undefined;
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      ...(details ? { details } : {}),
      ...(cause ? { cause } : {}),
    };
  }
  return {
    name: 'UnknownError',
    message: String(error),
  };
}

function errorDetails(error: Error): Record<string, unknown> | undefined {
  const details = (error as Error & { details?: unknown }).details;
  if (details !== null && typeof details === 'object' && !Array.isArray(details)) {
    return details as Record<string, unknown>;
  }
  return undefined;
}

export class Logger implements ILogger {
  private level: LogLevel;
  private readonly service?: string;
  private readonly transport: LogTransport;
  private readonly bindings: LogContext;

  constructor(options: LoggerOptions = {}, bindings: LogContext = {}) {
    this.level = resolveLevel(options.level ?? LogLevel.INFO);
    this.service = options.service;
    this.transport = options.transport ?? new ConsoleTransport();
    this.bindings = bindings;
  }

  setLevel(level: LogLevel | LogLevelName): void {
    this.level = resolveLevel(level);
  }

  child(bindings: LogContext & { service?: string }): ILogger {
    const { service, ...rest } = bindings;
    return new Logger(
      {
        level: this.level,
        service: service ?? this.service,
        transport: this.transport,
      },
      { ...this.bindings, ...rest },
    );
  }

  debug(message: string, context?: LogContext): void {
    this.log('DEBUG', LogLevel.DEBUG, message, context);
  }

  info(message: string, context?: LogContext): void {
    this.log('INFO', LogLevel.INFO, message, context);
  }

  warn(message: string, context?: LogContext): void {
    this.log('WARN', LogLevel.WARN, message, context);
  }

  error(message: string, context?: LogContext, error?: unknown): void {
    this.log('ERROR', LogLevel.ERROR, message, context, error);
  }

  fatal(message: string, context?: LogContext, error?: unknown): void {
    this.log('FATAL', LogLevel.FATAL, message, context, error);
  }

  private log(
    levelName: LogLevelName,
    level: LogLevel,
    message: string,
    context?: LogContext,
    error?: unknown,
  ): void {
    if (level < this.level) {
      return;
    }

    const entry: LogEntry = {
      level: levelName,
      message,
      timestamp: new Date().toISOString(),
      ...(this.service ? { service: this.service } : {}),
      ...(Object.keys(this.bindings).length > 0 || context
        ? { context: { ...this.bindings, ...context } }
        : {}),
      ...(error !== undefined ? { error: serializeError(error) } : {}),
    };

    this.transport.write(entry);
  }
}

export function createLogger(options?: LoggerOptions): ILogger {
  return new Logger(options);
}
