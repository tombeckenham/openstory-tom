/**
 * Pure logic for re-ordering the scenes (frames) of a sequence.
 *
 * `orderIndex` is the source of truth for scene order (it drives list queries
 * and final video assembly). `metadata.sceneNumber` is a display label that we
 * keep in lock-step with the new position so "Scene N" always matches the
 * top-to-bottom order the user just arranged.
 */

import type { Scene } from '@/lib/ai/scene-analysis.schema';

export type FrameReorderInput = {
  id: string;
  metadata: Scene | null;
};

export type FrameReorderUpdate = {
  id: string;
  orderIndex: number;
  /** New metadata with `sceneNumber` renumbered, or null when none exists. */
  metadata: Scene | null;
};

/**
 * Given the sequence's current frames and the desired top-to-bottom id order,
 * produce the per-frame `orderIndex` + renumbered `metadata` updates.
 *
 * `orderedFrameIds` MUST be a permutation of the existing frame ids — exactly
 * the full set, no extras, no duplicates. This guarantees the downstream
 * two-phase write covers every row that participates in the unique
 * `(sequenceId, orderIndex)` index, and that renumbering stays consistent.
 */
export function buildFrameReorder(
  existingFrames: FrameReorderInput[],
  orderedFrameIds: string[]
): FrameReorderUpdate[] {
  if (orderedFrameIds.length !== existingFrames.length) {
    throw new Error(
      `Reorder must include every frame exactly once (expected ${existingFrames.length}, got ${orderedFrameIds.length})`
    );
  }

  const existingById = new Map(existingFrames.map((f) => [f.id, f]));
  const seen = new Set<string>();
  const updates: FrameReorderUpdate[] = [];

  for (let index = 0; index < orderedFrameIds.length; index++) {
    const id = orderedFrameIds[index];
    if (id === undefined) continue;

    if (seen.has(id)) {
      throw new Error(`Duplicate frame id in reorder: ${id}`);
    }
    seen.add(id);

    const frame = existingById.get(id);
    if (!frame) {
      throw new Error(`Frame ${id} does not belong to this sequence`);
    }

    const sceneNumber = index + 1;
    const metadata = frame.metadata
      ? { ...frame.metadata, sceneNumber }
      : frame.metadata;

    updates.push({ id, orderIndex: index, metadata });
  }

  return updates;
}
