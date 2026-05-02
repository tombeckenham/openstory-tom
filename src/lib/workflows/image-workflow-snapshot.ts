/**
 * Snapshot DTO hashers for `generateImageWorkflow`.
 *
 * `computeFromDto` hashes the inlined per-scene snapshot for the start-time
 * tamper check. `computeCurrent` re-resolves the live character / location /
 * element sheet hashes from the scoped DB so the workflow can detect upstream
 * drift between trigger and write time and route divergent results into
 * `frame_variants` instead of overwriting the primary thumbnail.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Pillar 3: Divergence-on-completion".
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import type {
  FrameImageSceneSnapshot,
  ImageWorkflowInput,
} from '@/lib/workflow/types';
import { computeFrameImageSceneHash } from './sheet-snapshots';
import {
  matchCharactersToScene,
  matchElementsToScene,
  matchLocationsToScene,
} from './scene-matching';

const NO_SNAPSHOT_SENTINEL = '';

function sortedHashes(values: Array<string | null | undefined>): string[] {
  return values
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .sort();
}

export function computeImageWorkflowHashFromDto(
  input: ImageWorkflowInput
): Promise<string> | string {
  if (!input.sceneSnapshot) {
    // No snapshot opted in. The body must not call `validate()` in this path;
    // returning the inlined hash (or empty sentinel) keeps validate() honest
    // for callers that *do* opt in via a missing snapshotInputHash (which
    // would mismatch and throw).
    return input.snapshotInputHash ?? NO_SNAPSHOT_SENTINEL;
  }
  return computeFrameImageSceneHash(
    input.sceneSnapshot,
    input.model ?? DEFAULT_IMAGE_MODEL,
    input.aspectRatio ?? DEFAULT_ASPECT_RATIO
  );
}

/**
 * Re-resolve the live sheet hashes for the frame's scene and recompute the
 * snapshot hash. Falls back to the DTO hash when the workflow has no scene
 * snapshot or the frame has been deleted — the caller treats matching hashes
 * as "convergent" so a missing frame collapses to the convergent path
 * (image-workflow already short-circuits on deleted frames upstream).
 */
export async function computeImageWorkflowHashCurrent(
  input: ImageWorkflowInput,
  scopedDb: ScopedDb
): Promise<string> {
  if (!input.sceneSnapshot)
    return input.snapshotInputHash ?? NO_SNAPSHOT_SENTINEL;

  const model = input.model ?? DEFAULT_IMAGE_MODEL;
  const aspectRatio = input.aspectRatio ?? DEFAULT_ASPECT_RATIO;

  if (!input.sequenceId || !input.frameId) {
    return computeFrameImageSceneHash(input.sceneSnapshot, model, aspectRatio);
  }

  const frame = await scopedDb.frames.getById(input.frameId);
  // Deleted mid-flight: fall back to DTO hash so the divergence check returns
  // "convergent". image-workflow's storage step already returns early on
  // deleted frames, so this branch is just belt-and-braces.
  if (!frame?.metadata) {
    return computeFrameImageSceneHash(input.sceneSnapshot, model, aspectRatio);
  }

  const [characters, locations, elements] = await Promise.all([
    scopedDb.characters.listWithSheets(input.sequenceId),
    scopedDb.sequenceLocations.listWithReferences(input.sequenceId),
    scopedDb.sequenceElements.list(input.sequenceId),
  ]);

  const scene = frame.metadata;
  const matchedCharacters = matchCharactersToScene(
    characters,
    scene.continuity?.characterTags ?? []
  );
  const matchedLocations = matchLocationsToScene(
    locations,
    scene.continuity?.environmentTag ?? '',
    scene.metadata?.location ?? ''
  );
  const matchedElements = matchElementsToScene(
    elements,
    scene.continuity?.elementTags ?? [],
    scene.originalScript?.extract ?? ''
  );

  const currentSnapshot: FrameImageSceneSnapshot = {
    sceneId: input.sceneSnapshot.sceneId,
    visualPrompt: input.sceneSnapshot.visualPrompt,
    characterSheetHashes: sortedHashes(
      matchedCharacters.map((c) => c.sheetInputHash)
    ),
    locationSheetHashes: sortedHashes(
      matchedLocations.map((l) => l.referenceInputHash)
    ),
    elementReferenceHashes: sortedHashes(
      matchedElements.map((e) => e.imageUrl)
    ),
  };

  return computeFrameImageSceneHash(currentSnapshot, model, aspectRatio);
}
