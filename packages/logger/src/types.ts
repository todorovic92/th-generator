export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
  FATAL = 4,
  SILENT = 5,
}

export type LogLevelName = keyof typeof LogLevel;

export const LOG_LEVEL_NAMES = Object.keys(LogLevel).filter((key) =>
  Number.isNaN(Number(key)),
) as LogLevelName[];

export interface LogContext {
  [key: string]: unknown;
}

export interface SerializedError {
  name: string;
  message: string;
  stack?: string;
  details?: Record<string, unknown>;
  cause?: SerializedError;
}

export interface LogEntry {
  level: LogLevelName;
  message: string;
  timestamp: string;
  service?: string;
  context?: LogContext;
  error?: SerializedError;
}

export interface LoggerOptions {
  /** Minimum level to emit. Defaults to INFO. */
  level?: LogLevel | LogLevelName;
  /** Service / component name attached to every entry. */
  service?: string;
  /** Custom sink; defaults to structured JSON on stdout/stderr. */
  transport?: LogTransport;
}

export interface LogTransport {
  write(entry: LogEntry): void;
}

export interface ILogger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext, error?: unknown): void;
  fatal(message: string, context?: LogContext, error?: unknown): void;
  child(bindings: LogContext & { service?: string }): ILogger;
  setLevel(level: LogLevel | LogLevelName): void;
}
