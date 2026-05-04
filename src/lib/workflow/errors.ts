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

/** Marker substring embedded in failResponse so failure handlers can detect divergence. */
export const SNAPSHOT_DIVERGED_MARKER = '[SnapshotDiverged]';

/**
 * Non-retryable error thrown by snapshot-pattern workflows when the upstream
 * inputs diverged between trigger time and write time. The workflow has
 * already re-queued itself with current inputs; the throw aborts the current
 * run so callers don't observe the orphaned (un-persisted) URL as success.
 *
 * The constructor force-prepends `SNAPSHOT_DIVERGED_MARKER` so failure
 * handlers can detect divergence via `isSnapshotDivergedFailure(failResponse)`
 * regardless of how callers phrase the message.
 */
export class SnapshotDivergedError extends WorkflowNonRetryableError {
  constructor(message: string) {
    super(`${SNAPSHOT_DIVERGED_MARKER} ${message}`);
    this.name = 'SnapshotDivergedError';
  }
}

/**
 * Non-retryable error thrown when a snapshot-pattern workflow has hit
 * `MAX_REQUEUE_DEPTH` and refuses to re-queue further. Distinct from
 * `SnapshotDivergedError` because the failure handler must mark the artifact
 * failed (no further re-queue is in flight).
 */
export class SnapshotRequeueDepthExceededError extends WorkflowNonRetryableError {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotRequeueDepthExceededError';
  }
}

export function isSnapshotDivergedFailure(failResponse: string): boolean {
  return failResponse.includes(SNAPSHOT_DIVERGED_MARKER);
}
