import { WorkflowNonRetryableError } from '@upstash/workflow';

/**
 * Non-retryable error for validation failures.
 * Used when input is invalid, missing required fields, or fails validation rules.
 * QStash will NOT retry when this error is thrown.
 *
 * @example
 * throw new WorkflowValidationError('Script is too short (minimum 50 characters)');
 */
export class WorkflowValidationError extends WorkflowNonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowValidationError';
  }
}
