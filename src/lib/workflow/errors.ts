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

/**
 * Non-retryable error thrown by snapshot-pattern workflows when the upstream
 * inputs diverged between trigger time and write time. The workflow has
 * already re-queued itself with current inputs; the throw aborts the current
 * run so callers don't observe the orphaned (un-persisted) URL as success.
 *
 * Failure handlers that detect this name treat it as a transient re-queue
 * rather than a hard generation failure.
 */
export class SnapshotDivergedError extends WorkflowNonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotDivergedError';
  }
}

/** Marker substring embedded in failResponse so failure handlers can detect divergence. */
export const SNAPSHOT_DIVERGED_MARKER = '[SnapshotDiverged]';

export function isSnapshotDivergedFailure(failResponse: string): boolean {
  return failResponse.includes(SNAPSHOT_DIVERGED_MARKER);
}
