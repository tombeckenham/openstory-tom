/**
 * Sheet workflow divergence routing (Stage 2).
 *
 * Helpers for the character/location/talent sheet workflows to decide, at
 * write time, whether the freshly generated artifact is convergent (apply as
 * primary) or divergent (save to a `*_sheet_variants` table without
 * disturbing the live entity). Mirrors the per-frame divergence routing
 * already in place for `frame_variants`.
 *
 * The decision is a hash comparison: callers pass the `snapshotInputHash`
 * computed when the workflow was triggered (frozen in the QStash payload)
 * and the `currentInputHash` recomputed from live scoped-DB state at write
 * time. If they differ, the inputs changed mid-flight — the result belongs
 * in a variants row, and the UI is notified via `stale:detected`.
 */

import type { ScopedDb } from '@/lib/db/scoped';
import type { LocationSheetVariantParentType } from '@/lib/db/schema';
import { getGenerationChannel } from '@/lib/realtime';

export type SheetDivergenceDecision =
  | { kind: 'convergent' }
  | { kind: 'divergent'; snapshotInputHash: string; currentInputHash: string };

export function decideSheetDivergence(
  snapshotInputHash: string | null | undefined,
  currentInputHash: string | null | undefined
): SheetDivergenceDecision {
  // Either side missing means we can't prove divergence; treat as convergent
  // and let the parent row's hash get backfilled on write. This matches the
  // Stage 1 frame-variants policy of treating null hashes as
  // "unknown — never stale" rather than forcing a false-positive divergence.
  if (!snapshotInputHash || !currentInputHash) {
    return { kind: 'convergent' };
  }
  if (snapshotInputHash === currentInputHash) {
    return { kind: 'convergent' };
  }
  return {
    kind: 'divergent',
    snapshotInputHash,
    currentInputHash,
  };
}

type EmitArgs = {
  sequenceId?: string;
  entityType: 'character' | 'location' | 'library-location' | 'talent';
  entityId: string;
  artifact: 'sheet';
  snapshotInputHash: string;
  divergedVariantId: string;
};

async function emitStaleDetected({
  sequenceId,
  entityType,
  entityId,
  artifact,
  snapshotInputHash,
  divergedVariantId,
}: EmitArgs): Promise<void> {
  await getGenerationChannel(sequenceId).emit('generation.stale:detected', {
    entityType,
    entityId,
    artifact,
    snapshotInputHash,
    divergedVariantId,
  });
}

export type SaveDivergentCharacterSheetArgs = {
  scopedDb: ScopedDb;
  characterId: string;
  sequenceId?: string;
  model: string;
  url: string;
  storagePath?: string;
  workflowRunId?: string;
  snapshotInputHash: string;
};

export async function saveDivergentCharacterSheet({
  scopedDb,
  characterId,
  sequenceId,
  model,
  url,
  storagePath,
  workflowRunId,
  snapshotInputHash,
}: SaveDivergentCharacterSheetArgs): Promise<string> {
  const variant = await scopedDb.characterSheetVariants.insert({
    characterId,
    model,
    url,
    storagePath: storagePath ?? null,
    workflowRunId: workflowRunId ?? null,
    status: 'completed',
    generatedAt: new Date(),
    inputHash: snapshotInputHash,
    divergedAt: new Date(),
  });
  await emitStaleDetected({
    sequenceId,
    entityType: 'character',
    entityId: characterId,
    artifact: 'sheet',
    snapshotInputHash,
    divergedVariantId: variant.id,
  });
  return variant.id;
}

export type SaveDivergentLocationSheetArgs = {
  scopedDb: ScopedDb;
  parentType: LocationSheetVariantParentType;
  parentId: string;
  sequenceId?: string;
  model: string;
  url: string;
  storagePath?: string;
  workflowRunId?: string;
  snapshotInputHash: string;
};

export async function saveDivergentLocationSheet({
  scopedDb,
  parentType,
  parentId,
  sequenceId,
  model,
  url,
  storagePath,
  workflowRunId,
  snapshotInputHash,
}: SaveDivergentLocationSheetArgs): Promise<string> {
  const variant = await scopedDb.locationSheetVariants.insert({
    parentType,
    parentId,
    model,
    url,
    storagePath: storagePath ?? null,
    workflowRunId: workflowRunId ?? null,
    status: 'completed',
    generatedAt: new Date(),
    inputHash: snapshotInputHash,
    divergedAt: new Date(),
  });
  await emitStaleDetected({
    sequenceId,
    entityType:
      parentType === 'library_location' ? 'library-location' : 'location',
    entityId: parentId,
    artifact: 'sheet',
    snapshotInputHash,
    divergedVariantId: variant.id,
  });
  return variant.id;
}

export type SaveDivergentTalentSheetArgs = {
  scopedDb: ScopedDb;
  talentSheetId: string;
  /** For realtime channel routing; talent workflows don't use sequence channels. */
  sequenceId?: string;
  model: string;
  url: string;
  storagePath?: string;
  workflowRunId?: string;
  snapshotInputHash: string;
};

export async function saveDivergentTalentSheet({
  scopedDb,
  talentSheetId,
  sequenceId,
  model,
  url,
  storagePath,
  workflowRunId,
  snapshotInputHash,
}: SaveDivergentTalentSheetArgs): Promise<string> {
  const variant = await scopedDb.talentSheetVariants.insert({
    talentSheetId,
    model,
    url,
    storagePath: storagePath ?? null,
    workflowRunId: workflowRunId ?? null,
    status: 'completed',
    generatedAt: new Date(),
    inputHash: snapshotInputHash,
    divergedAt: new Date(),
  });
  await emitStaleDetected({
    sequenceId,
    entityType: 'talent',
    entityId: talentSheetId,
    artifact: 'sheet',
    snapshotInputHash,
    divergedVariantId: variant.id,
  });
  return variant.id;
}
