/**
 * Behavioural tests for `OpenStoryWorkflowEntrypoint.run()`'s failure
 * handling, added for issue #839 (June 6 mass-abort cascade):
 *
 *   1. Engine aborts ("Aborting engine: Grace period complete") are transient
 *      — CF resumes the instance afterwards — so run() must rethrow WITHOUT
 *      invoking `onFailure` (which marks user-facing rows failed) or
 *      notifying the parent of failure.
 *   2. A successful child whose parent already reached a finite state must
 *      return its result normally instead of retroactively failing.
 *   3. Real failures keep the existing contract: onFailure runs, the parent
 *      is notified, and the original error is rethrown.
 */

import { describe, expect, test, vi } from 'vitest';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import type { ScopedDb } from '@/lib/db/scoped';
import type { UserWorkflowContext } from '@/lib/workflow/types';

const SCOPED_DB = { scoped: true };

vi.doMock('@/lib/db/scoped', () => ({
  createScopedDb: vi.fn(() => SCOPED_DB),
}));
vi.doMock('@/lib/ai/fal-config', () => ({
  configureFalProxyFromEnv: vi.fn(),
}));

const notifyParent = vi.fn();
const notifyParentOfFailure = vi.fn();
vi.doMock('@/lib/workflow/await-child', async () => {
  const real = await vi.importActual('@/lib/workflow/await-child');
  return { ...real, notifyParent, notifyParentOfFailure };
});

// Dynamic import so the mocks above apply (vi.doMock is not hoisted).
const { OpenStoryWorkflowEntrypoint } = await import('./base-workflow');

const IN_FINITE_STATE =
  '(instance.in_finite_state) Instance reached a finite state, cannot send events to it';
const ENGINE_ABORT = 'Aborting engine: Grace period complete';

type TestPayload = UserWorkflowContext & {
  _parent?: {
    bindingName: string;
    parentInstanceId: string;
    eventType: string;
  };
};

const PARENT_HINT = {
  bindingName: 'STORYBOARD_WORKFLOW',
  parentInstanceId: 'parent_run_A',
  eventType: 'done-child_01XYZ',
};

function makeEvent(withParent: boolean): Readonly<WorkflowEvent<TestPayload>> {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowEvent stub: run() only reads payload + instanceId
  return {
    payload: {
      userId: 'u1',
      teamId: 't1',
      ...(withParent ? { _parent: PARENT_HINT } : {}),
    },
    instanceId: 'child_run_A',
    timestamp: new Date(0),
  } as unknown as Readonly<WorkflowEvent<TestPayload>>;
}

function makeStep(): WorkflowStep {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: run() only uses `do`
  return {
    do: vi.fn((_name: string, fn: () => Promise<unknown>) => fn()),
  } as unknown as WorkflowStep;
}

function makeWorkflow(impl: () => Promise<unknown>) {
  const onFailure = vi.fn();
  class TestWorkflow extends OpenStoryWorkflowEntrypoint<TestPayload> {
    protected override runImpl(): Promise<unknown> {
      return impl();
    }
    protected override onFailure(failure: {
      event: Readonly<WorkflowEvent<TestPayload>>;
      error: string;
      scopedDb: ScopedDb;
    }): void {
      onFailure(failure);
    }
  }
  type Ctor = ConstructorParameters<typeof TestWorkflow>;
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tests construct the entrypoint directly; the stubbed base class ignores ctx
  const ctx = undefined as unknown as Ctor[0];
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal env stub; run() under test never reads bindings
  const env = {} as unknown as Ctor[1];
  const workflow = new TestWorkflow(ctx, env);
  return { workflow, onFailure };
}

describe('OpenStoryWorkflowEntrypoint.run', () => {
  test('engine abort: rethrows without onFailure or parent failure-notify', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.reject(new Error(ENGINE_ABORT))
    );

    await expect(workflow.run(makeEvent(true), makeStep())).rejects.toThrow(
      'Grace period complete'
    );

    expect(onFailure).not.toHaveBeenCalled();
    expect(notifyParentOfFailure).not.toHaveBeenCalled();
  });

  test('success with dead parent: returns the result instead of failing', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    notifyParent.mockRejectedValue(new Error(IN_FINITE_STATE));
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.resolve({ scenes: 3 })
    );

    const result = await workflow.run(makeEvent(true), makeStep());

    expect(result).toEqual({ scenes: 3 });
    expect(onFailure).not.toHaveBeenCalled();
    expect(notifyParentOfFailure).not.toHaveBeenCalled();
  });

  test('real failure: onFailure runs, parent notified, error rethrown', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    notifyParentOfFailure.mockResolvedValue(undefined);
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.reject(new Error('fal request failed'))
    );

    await expect(workflow.run(makeEvent(true), makeStep())).rejects.toThrow(
      'fal request failed'
    );

    expect(onFailure).toHaveBeenCalledTimes(1);
    expect(notifyParentOfFailure).toHaveBeenCalledTimes(1);
  });

  test('real failure with dead parent: failure-notify rejection is swallowed', async () => {
    notifyParent.mockReset();
    notifyParentOfFailure.mockReset();
    notifyParentOfFailure.mockRejectedValue(new Error(IN_FINITE_STATE));
    const { workflow, onFailure } = makeWorkflow(() =>
      Promise.reject(new Error('fal request failed'))
    );

    // The ORIGINAL error surfaces, not the notify error.
    await expect(workflow.run(makeEvent(true), makeStep())).rejects.toThrow(
      'fal request failed'
    );
    expect(onFailure).toHaveBeenCalledTimes(1);
  });

  test('success without a parent hint never notifies', async () => {
    notifyParent.mockReset();
    const { workflow } = makeWorkflow(() => Promise.resolve('ok'));

    await expect(workflow.run(makeEvent(false), makeStep())).resolves.toBe(
      'ok'
    );
    expect(notifyParent).not.toHaveBeenCalled();
  });
});
