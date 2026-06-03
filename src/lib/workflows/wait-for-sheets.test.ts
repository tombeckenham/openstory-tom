/**
 * Tests for the matching-workflow sheet-wait helpers.
 *
 * These close the race where a newly-added talent/location's sheet generation
 * (fire-and-forget `/library-talent-sheet` / `/library-location-sheet`) hasn't
 * finished when `talent-matching` / `location-matching` reads the row. The wait
 * must: short-circuit when everything is already ready, poll across durable
 * steps until pending entities become ready, and give up (best-effort) after a
 * bounded number of attempts so a failed sheet can't stall the pipeline.
 */

import type { ScopedDb } from '@/lib/db/scoped';
import type { WorkflowStep } from 'cloudflare:workers';
import { describe, expect, test, vi } from 'vitest';
import {
  waitForElementVision,
  waitForLocationReferences,
  waitForTalentSheets,
} from './wait-for-sheets';

/**
 * Minimal `step` stub. `do` runs the durable callback once (one engine
 * attempt) and returns its value; `sleep` is a no-op we can assert on.
 */
function fakeStep(): {
  step: WorkflowStep;
  doSpy: ReturnType<typeof vi.fn>;
  sleepSpy: ReturnType<typeof vi.fn>;
} {
  const doSpy = vi.fn((_name: string, fn: () => Promise<unknown>) => fn());
  const sleepSpy = vi.fn(async () => undefined);
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- minimal WorkflowStep stub: helper only uses `do` and `sleep`
  const step = { do: doSpy, sleep: sleepSpy } as unknown as WorkflowStep;
  return { step, doSpy, sleepSpy };
}

/** ScopedDb stub exposing only `talent.getByIds`. */
function talentDb(getByIds: ReturnType<typeof vi.fn>): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- helper only reaches scopedDb.talent.getByIds
  return { talent: { getByIds } } as unknown as ScopedDb;
}

/** ScopedDb stub exposing only `locations.getByIds`. */
function locationDb(getByIds: ReturnType<typeof vi.fn>): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- helper only reaches scopedDb.locations.getByIds
  return { locations: { getByIds } } as unknown as ScopedDb;
}

/** ScopedDb stub exposing `sequenceElements.list` + `.listByIds`. */
function elementDb(
  list: ReturnType<typeof vi.fn>,
  listByIds: ReturnType<typeof vi.fn>
): ScopedDb {
  // oxlint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- helper only reaches scopedDb.sequenceElements.{list,listByIds}
  return { sequenceElements: { list, listByIds } } as unknown as ScopedDb;
}

describe('waitForTalentSheets', () => {
  test('returns ready without reading the DB when there are no ids', async () => {
    const { step, doSpy, sleepSpy } = fakeStep();
    const getByIds = vi.fn();

    const result = await waitForTalentSheets(step, talentDb(getByIds), []);

    expect(result).toEqual({ ready: true, pendingIds: [] });
    expect(getByIds).not.toHaveBeenCalled();
    expect(doSpy).not.toHaveBeenCalled();
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('short-circuits on the first read when every sheet is ready', async () => {
    const { step, sleepSpy } = fakeStep();
    const getByIds = vi.fn(async () => [
      { id: 't1', defaultSheet: { imageUrl: 'https://cdn/t1.png' } },
      { id: 't2', defaultSheet: { imageUrl: 'https://cdn/t2.png' } },
    ]);

    const result = await waitForTalentSheets(step, talentDb(getByIds), [
      't1',
      't2',
    ]);

    expect(result).toEqual({ ready: true, pendingIds: [] });
    expect(getByIds).toHaveBeenCalledTimes(1);
    // Ready immediately → never sleeps.
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('polls until the pending sheet appears, sleeping between reads', async () => {
    const { step, sleepSpy } = fakeStep();
    const getByIds = vi
      .fn()
      // 1st read: t2 has no sheet yet.
      .mockResolvedValueOnce([
        { id: 't1', defaultSheet: { imageUrl: 'https://cdn/t1.png' } },
        { id: 't2', defaultSheet: null },
      ])
      // 2nd read: still missing (defaultSheet present but no imageUrl).
      .mockResolvedValueOnce([
        { id: 't1', defaultSheet: { imageUrl: 'https://cdn/t1.png' } },
        { id: 't2', defaultSheet: { imageUrl: null } },
      ])
      // 3rd read: ready.
      .mockResolvedValueOnce([
        { id: 't1', defaultSheet: { imageUrl: 'https://cdn/t1.png' } },
        { id: 't2', defaultSheet: { imageUrl: 'https://cdn/t2.png' } },
      ]);

    const result = await waitForTalentSheets(step, talentDb(getByIds), [
      't1',
      't2',
    ]);

    expect(result).toEqual({ ready: true, pendingIds: [] });
    expect(getByIds).toHaveBeenCalledTimes(3);
    // Slept after the two not-ready reads, not after the ready one.
    expect(sleepSpy).toHaveBeenCalledTimes(2);
  });

  test('ignores ids the scoped read does not return (deleted / not owned)', async () => {
    const { step } = fakeStep();
    // 'ghost' is requested but never returned by getByIds — must not be waited on.
    const getByIds = vi.fn(async () => [
      { id: 't1', defaultSheet: { imageUrl: 'https://cdn/t1.png' } },
    ]);

    const result = await waitForTalentSheets(step, talentDb(getByIds), [
      't1',
      'ghost',
    ]);

    expect(result).toEqual({ ready: true, pendingIds: [] });
    expect(getByIds).toHaveBeenCalledTimes(1);
  });

  test('fires onWaitNeeded exactly once, only when a wait is actually needed', async () => {
    const { step } = fakeStep();
    const onWaitNeeded = vi.fn(async () => undefined);
    const getByIds = vi
      .fn()
      .mockResolvedValueOnce([{ id: 't1', defaultSheet: null }])
      .mockResolvedValueOnce([{ id: 't1', defaultSheet: null }])
      .mockResolvedValueOnce([
        { id: 't1', defaultSheet: { imageUrl: 'https://cdn/t1.png' } },
      ]);

    const result = await waitForTalentSheets(step, talentDb(getByIds), ['t1'], {
      onWaitNeeded,
    });

    expect(result.ready).toBe(true);
    // Fired once, on first discovery of a pending sheet, with the pending count.
    expect(onWaitNeeded).toHaveBeenCalledTimes(1);
    expect(onWaitNeeded).toHaveBeenCalledWith(1);
  });

  test('does not fire onWaitNeeded when everything is already ready', async () => {
    const { step } = fakeStep();
    const onWaitNeeded = vi.fn(async () => undefined);
    const getByIds = vi.fn(async () => [
      { id: 't1', defaultSheet: { imageUrl: 'https://cdn/t1.png' } },
    ]);

    await waitForTalentSheets(step, talentDb(getByIds), ['t1'], {
      onWaitNeeded,
    });

    expect(onWaitNeeded).not.toHaveBeenCalled();
  });

  test('gives up after the bounded number of attempts and reports pending ids', async () => {
    const { step, doSpy, sleepSpy } = fakeStep();
    // Never becomes ready.
    const getByIds = vi.fn(async () => [{ id: 't1', defaultSheet: null }]);

    const result = await waitForTalentSheets(step, talentDb(getByIds), ['t1']);

    expect(result.ready).toBe(false);
    expect(result.pendingIds).toEqual(['t1']);
    // One check per attempt; one fewer sleep (no sleep after the final check).
    const attempts = getByIds.mock.calls.length;
    expect(attempts).toBeGreaterThan(1);
    expect(doSpy).toHaveBeenCalledTimes(attempts);
    expect(sleepSpy).toHaveBeenCalledTimes(attempts - 1);
  });
});

describe('waitForLocationReferences', () => {
  test('returns ready immediately for no ids', async () => {
    const { step } = fakeStep();
    const getByIds = vi.fn();

    const result = await waitForLocationReferences(
      step,
      locationDb(getByIds),
      []
    );

    expect(result).toEqual({ ready: true, pendingIds: [] });
    expect(getByIds).not.toHaveBeenCalled();
  });

  test('short-circuits when every location has a reference image', async () => {
    const { step, sleepSpy } = fakeStep();
    const getByIds = vi.fn(async () => [
      { id: 'l1', referenceImageUrl: 'https://cdn/l1.png' },
    ]);

    const result = await waitForLocationReferences(step, locationDb(getByIds), [
      'l1',
    ]);

    expect(result).toEqual({ ready: true, pendingIds: [] });
    expect(getByIds).toHaveBeenCalledTimes(1);
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('polls until the reference image is written', async () => {
    const { step, sleepSpy } = fakeStep();
    const getByIds = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'l1', referenceImageUrl: null }])
      .mockResolvedValueOnce([
        { id: 'l1', referenceImageUrl: 'https://cdn/l1.png' },
      ]);

    const result = await waitForLocationReferences(step, locationDb(getByIds), [
      'l1',
    ]);

    expect(result).toEqual({ ready: true, pendingIds: [] });
    expect(getByIds).toHaveBeenCalledTimes(2);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });
});

describe('waitForElementVision', () => {
  test('short-circuits without polling when no element is in flight', async () => {
    const { step, sleepSpy } = fakeStep();
    // Terminal states only ('completed' / 'failed') → nothing to wait on.
    const list = vi.fn(async () => [
      { id: 'e1', visionStatus: 'completed' },
      { id: 'e2', visionStatus: 'failed' },
    ]);
    const listByIds = vi.fn();

    const result = await waitForElementVision(
      step,
      elementDb(list, listByIds),
      'seq1'
    );

    expect(result).toEqual({ ready: true, pendingIds: [] });
    expect(list).toHaveBeenCalledTimes(1);
    // Nothing in flight → the by-id poll never runs.
    expect(listByIds).not.toHaveBeenCalled();
    expect(sleepSpy).not.toHaveBeenCalled();
  });

  test('polls only the in-flight elements until vision is terminal', async () => {
    const { step, sleepSpy } = fakeStep();
    // Scan: e1 done, e2 still analyzing → only e2 enters the wait set.
    const list = vi.fn(async () => [
      { id: 'e1', visionStatus: 'completed' },
      { id: 'e2', visionStatus: 'analyzing' },
    ]);
    const listByIds = vi
      .fn()
      .mockResolvedValueOnce([{ id: 'e2', visionStatus: 'analyzing' }])
      .mockResolvedValueOnce([{ id: 'e2', visionStatus: 'completed' }]);

    const result = await waitForElementVision(
      step,
      elementDb(list, listByIds),
      'seq1'
    );

    expect(result).toEqual({ ready: true, pendingIds: [] });
    expect(list).toHaveBeenCalledTimes(1);
    expect(listByIds).toHaveBeenCalledTimes(2);
    expect(listByIds).toHaveBeenLastCalledWith(['e2']);
    expect(sleepSpy).toHaveBeenCalledTimes(1);
  });

  test('gives up after the bounded number of attempts and reports pending ids', async () => {
    const { step } = fakeStep();
    const list = vi.fn(async () => [{ id: 'e1', visionStatus: 'pending' }]);
    // Never leaves 'analyzing'.
    const listByIds = vi.fn(async () => [
      { id: 'e1', visionStatus: 'analyzing' },
    ]);

    const result = await waitForElementVision(
      step,
      elementDb(list, listByIds),
      'seq1'
    );

    expect(result.ready).toBe(false);
    expect(result.pendingIds).toEqual(['e1']);
  });
});
