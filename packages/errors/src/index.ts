/**
 * Base for errors that cross a package boundary and must be classified by the
 * worker. Concrete errors live beside the code that throws them.
 */
export class AppError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(
    message: string,
    options: {
      code: string;
      retryable?: boolean;
      details?: Record<string, unknown>;
      cause?: unknown;
    },
  ) {
    super(message, options.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = this.constructor.name;
    this.code = options.code;
    this.retryable = options.retryable ?? false;
    this.details = options.details;
  }
}

/**
 * Unknown / unexpected errors are treated as transient (retryable).
 * Only explicit AppError.retryable === false is permanent.
 */
export function isRetryableError(error: unknown): boolean {
  if (error instanceof AppError) {
    return error.retryable;
  }
  return true;
}
