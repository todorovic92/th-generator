import { AppError } from '@thumbnail-generator/errors';

export class DatabaseError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, { code: 'DATABASE_ERROR', retryable: true, details, cause });
  }
}
