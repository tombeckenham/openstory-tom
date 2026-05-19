/**
 * Base class for Cloudflare Workflows entrypoints.
 *
 * Wraps `run()` with a sanitized failure handler that mirrors the QStash
 * `failureFunction` contract — when the workflow body throws, the wrapper
 * extracts a friendly message, calls a subclass-supplied `onFailure` (typed),
 * and rethrows so CF marks the instance as `errored`.
 *
 * Subclasses implement `runImpl(event, step, scopedDb)` and optionally
 * `onFailure({ event, error, scopedDb })`. The base class:
 *   - Validates `userId` / `teamId` on the payload (same contract as
 *     `createScopedWorkflow`'s teamId middleware).
 *   - Builds a `ScopedDb` from the payload and hands it to both `runImpl`
 *     and `onFailure`.
 *   - Sanitizes the error message and emits it in a `step.do('emit-failure')`
 *     so the failure write itself benefits from retries + step durability.
 *
 * See docs/investigations/cloudflare-workflows.md §4 Gap D.
 */

import { createScopedDb, type ScopedDb } from '@/lib/db/scoped';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import type { UserWorkflowContext } from '@/lib/workflow/types';
import type { CloudflareEnv } from '@/lib/workflow/cf/types';
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from 'cloudflare:workers';

export type OpenStoryFailureContext<T extends UserWorkflowContext> = {
  event: Readonly<WorkflowEvent<T>>;
  error: string;
  scopedDb: ScopedDb;
};

export abstract class OpenStoryWorkflowEntrypoint<
  T extends UserWorkflowContext,
> extends WorkflowEntrypoint<CloudflareEnv, T> {
  /**
   * Subclasses implement workflow logic here. Receives the same `event` /
   * `step` the engine hands to `run()`, plus a `ScopedDb` bound to the
   * payload's `(teamId, userId)`.
   */
  protected abstract runImpl(
    event: Readonly<WorkflowEvent<T>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<unknown>;

  /**
   * Optional failure hook. Runs inside a `step.do('emit-failure')` so the
   * cleanup write itself is retried by the engine. The original error is
   * rethrown after this returns — the workflow ends in `errored` state.
   */
  protected onFailure?(
    failure: OpenStoryFailureContext<T>
  ): Promise<void> | void;

  override async run(
    event: Readonly<WorkflowEvent<T>>,
    step: WorkflowStep
  ): Promise<unknown> {
    if (!event.payload.teamId || !event.payload.userId) {
      throw new Error(
        `[${this.constructor.name}] payload missing teamId or userId — every workflow extending OpenStoryWorkflowEntrypoint must include both`
      );
    }

    const scopedDb = createScopedDb(event.payload.teamId, event.payload.userId);

    try {
      return await this.runImpl(event, step, scopedDb);
    } catch (error) {
      const sanitized = sanitizeFailResponse(error);
      console.error(`[${this.constructor.name}] Failure:`, sanitized);

      if (this.onFailure) {
        // Wrap in step.do so cleanup retries on its own merits and doesn't
        // mask the original throw — if the cleanup fails after its own
        // retries, both errors surface in the instance status.
        await step.do('emit-failure', async () => {
          try {
            await this.onFailure?.({ event, error: sanitized, scopedDb });
          } catch (cleanupError) {
            console.error(
              `[${this.constructor.name}] onFailure handler itself failed:`,
              cleanupError
            );
            // Swallow the cleanup error — the original error is what we
            // want to surface as the instance's terminal state.
          }
        });
      }

      throw error;
    }
  }
}
