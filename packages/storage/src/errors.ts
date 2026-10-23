import { AppError } from '@thumbnail-generator/errors';

export class StorageError extends AppError {
  constructor(message: string, details?: Record<string, unknown>, cause?: unknown) {
    super(message, { code: 'STORAGE_ERROR', retryable: true, details, cause });
  }
}
