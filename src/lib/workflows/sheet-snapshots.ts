/**
 * Snapshot DTO hashers for content-generation workflows that opt into the
 * snapshot pattern.
 *
 * The `compute*FromDto` helpers hash the inlined payload; `compute*Current`
 * helpers re-resolve the upstream inputs from the live scoped DB so the
 * workflow can detect divergence at write-time.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Per-workflow input surface".
 */

import {
  computeCharacterSheetInputHash,
  computeFrameImageInputHash,
  computeLocationSheetInputHash,
  computeTalentSheetInputHash,
  sha256Hex,
  type CharacterBibleHashFields,
  type FrameImageHashInput,
  type LocationBibleHashFields,
} from '@/lib/ai/input-hash';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { ScopedDb } from '@/lib/db/scoped';
import type { StyleConfig } from '@/lib/db/schema';
import type {
  CharacterSheetWorkflowInput,
  FrameImageSceneSnapshot,
  FrameImagesWorkflowInput,
  LibraryTalentSheetWorkflowInput,
  LocationSheetWorkflowInput,
} from '@/lib/workflow/types';

export type { FrameImageSceneSnapshot } from '@/lib/workflow/types';

/**
 * Hard cap on snapshot-divergence re-queues for a single workflow chain.
 * Each re-queue runs `generateImageWithProvider` + `deductWorkflowCredits`
 * before the divergence check, so an upstream that thrashes in a tight loop
 * would otherwise burn credits indefinitely.
 */
export const MAX_REQUEUE_DEPTH = 5;

/**
 * Resolve the upstream talent-sheet's `input_hash` for a sequence character.
 * Returns `null` when the character has no talent assignment, when the talent
 * has no sheets, or when the sheet predates hash tracking.
 */
export async function resolveTalentSheetHash(
  scopedDb: ScopedDb,
  characterDbId: string
): Promise<string | null> {
  const character = await scopedDb.characters.getById(characterDbId);
  if (!character?.talentId) return null;
  const talent = await scopedDb.talent.getWithRelations(character.talentId);
  const defaultSheet =
    talent?.sheets.find((s) => s.isDefault) ?? talent?.sheets[0];
  return defaultSheet?.inputHash ?? null;
}

/**
 * Resolve the parent library-location's `reference_input_hash` for a sequence
 * location. Returns `null` when the sequence location has no library
 * reference, or when the library row predates hash tracking.
 */
export async function resolveLibraryLocationReferenceHash(
  scopedDb: ScopedDb,
  locationDbId: string
): Promise<string | null> {
  const sequenceLocation =
    await scopedDb.sequenceLocations.getById(locationDbId);
  if (!sequenceLocation?.libraryLocationId) return null;
  const libraryLocation = await scopedDb.locations.getById(
    sequenceLocation.libraryLocationId
  );
  return libraryLocation?.referenceInputHash ?? null;
}

/** Hash a `StyleConfig` deterministically. `null`/`undefined` → 'no-style'. */
export async function computeStyleConfigHash(
  styleConfig: StyleConfig | null | undefined
): Promise<string> {
  if (!styleConfig) return 'no-style';
  return sha256Hex({
    artifact: 'style-config',
    mood: styleConfig.mood,
    artStyle: styleConfig.artStyle,
    lighting: styleConfig.lighting,
    colorPalette: styleConfig.colorPalette,
    cameraWork: styleConfig.cameraWork,
    referenceFilms: styleConfig.referenceFilms,
    colorGrading: styleConfig.colorGrading,
  });
}

function characterBibleFields(
  metadata: CharacterSheetWorkflowInput['characterMetadata']
): CharacterBibleHashFields {
  return {
    name: metadata.name,
    age: metadata.age,
    gender: metadata.gender ?? null,
    ethnicity: metadata.ethnicity ?? null,
    physicalDescription: metadata.physicalDescription ?? null,
    standardClothing: metadata.standardClothing ?? null,
    distinguishingFeatures: metadata.distinguishingFeatures ?? null,
    consistencyTag: metadata.consistencyTag ?? null,
  };
}

/**
 * Hash the character-sheet workflow payload. The `talentSheetInputHash` field
 * inlines the upstream talent-sheet's `input_hash` so that a recast triggered
 * against a then-current talent sheet binds to that exact upstream version.
 */
export async function computeCharacterSheetHashFromDto(
  input: CharacterSheetWorkflowInput & { talentSheetInputHash?: string | null }
): Promise<string> {
  return computeCharacterSheetInputHash({
    characterBible: characterBibleFields(input.characterMetadata),
    talentSheetHash: input.talentSheetInputHash ?? null,
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  });
}

/**
 * Recompute the hash from the current DB state. The character bible, style
 * config, and image model are frozen on the payload (they must not drift
 * mid-flight); we re-read the upstream talent sheet's `input_hash` since
 * that's the only upstream entity whose hash can change between trigger and
 * write.
 */
export async function computeCharacterSheetHashCurrent(
  input: CharacterSheetWorkflowInput,
  scopedDb: ScopedDb
): Promise<string> {
  const talentSheetInputHash = await resolveTalentSheetHash(
    scopedDb,
    input.characterDbId
  );
  return computeCharacterSheetHashFromDto({ ...input, talentSheetInputHash });
}

function locationBibleFields(
  metadata: LocationSheetWorkflowInput['locationMetadata']
): LocationBibleHashFields {
  return {
    name: metadata.name,
    description: metadata.description ?? null,
  };
}

/**
 * Hash the location-sheet workflow payload. `libraryLocationReferenceHash`
 * inlines the parent library location's `reference_input_hash` if the sheet
 * was triggered with a library reference; otherwise `null`.
 */
export async function computeLocationSheetHashFromDto(
  input: LocationSheetWorkflowInput & {
    libraryLocationReferenceHash?: string | null;
  }
): Promise<string> {
  return computeLocationSheetInputHash({
    locationBible: locationBibleFields(input.locationMetadata),
    libraryLocationReferenceHash: input.libraryLocationReferenceHash ?? null,
    styleConfigHash: await computeStyleConfigHash(input.styleConfig),
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  });
}

export async function computeLocationSheetHashCurrent(
  input: LocationSheetWorkflowInput,
  scopedDb: ScopedDb
): Promise<string> {
  const libraryLocationReferenceHash =
    await resolveLibraryLocationReferenceHash(scopedDb, input.locationDbId);
  return computeLocationSheetHashFromDto({
    ...input,
    libraryLocationReferenceHash,
  });
}

/**
 * Library talent sheets are content-addressed by the inlined reference URLs:
 * talent media is append-only in practice, so the snapshot is the URL set
 * itself. We hash via `computeTalentSheetInputHash` keyed on those URLs as
 * the reference-media identity (no external `media_id` lookup required).
 */
export async function computeLibraryTalentSheetHashFromDto(
  input: LibraryTalentSheetWorkflowInput
): Promise<string> {
  // Sort here so callers that forget to pre-sort get a stable hash. The
  // `Current` helper sorts the live media URLs the same way; without sorting
  // here, an unsorted DTO would diverge against a sorted DB read on every run.
  const referenceMediaHashes = [...(input.referenceImageUrls ?? [])].sort();
  return computeTalentSheetInputHash({
    talent: {
      name: input.talentName,
      description: input.talentDescription ?? null,
    },
    referenceMediaHashes,
    imageModel: input.imageModel ?? DEFAULT_IMAGE_MODEL,
  });
}

export async function computeLibraryTalentSheetHashCurrent(
  input: LibraryTalentSheetWorkflowInput,
  scopedDb: ScopedDb
): Promise<string> {
  const talent = await scopedDb.talent.getWithRelations(input.talentId);
  // Fall back to the payload list when the talent row vanished mid-flight —
  // the workflow will fail downstream on the missing record, but we shouldn't
  // mask the divergence check with a noisy lookup error here.
  const currentImageUrls =
    talent?.media
      .filter((m) => m.type === 'image')
      .map((m) => m.url)
      .sort() ??
    input.referenceImageUrls ??
    [];
  return computeLibraryTalentSheetHashFromDto({
    ...input,
    referenceImageUrls: currentImageUrls,
  });
}

/**
 * Hash one scene's snapshot — used to populate `thumbnail_input_hash` on the
 * frame row and `input_hash` on the matching primary `frame_variants` row.
 */
export function computeFrameImageSceneHash(
  scene: FrameImageSceneSnapshot,
  imageModel: string,
  aspectRatio: string
): Promise<string> {
  const hashInput: FrameImageHashInput = {
    kind: 'thumbnail',
    visualPrompt: scene.visualPrompt,
    imageModel,
    aspectRatio,
    characterSheetHashes: scene.characterSheetHashes,
    locationSheetHashes: scene.locationSheetHashes,
    elementReferenceHashes: scene.elementReferenceHashes,
  };
  return computeFrameImageInputHash(hashInput);
}

/**
 * Hash the full frame-images payload. Binds every scene snapshot — including
 * the upstream sheet hashes alongside each URL — so a payload that preserves
 * only `snapshotInputHash` cannot smuggle replaced reference images past
 * validation.
 */
export async function computeFrameImagesHashFromDto(
  input: FrameImagesWorkflowInput & {
    sceneSnapshots: FrameImageSceneSnapshot[];
  }
): Promise<string> {
  return sha256Hex({
    artifact: 'frame-images:batch',
    sequenceId: input.sequenceId ?? null,
    imageModel: input.imageModel ?? null,
    imageModels: input.imageModels ?? null,
    aspectRatio: input.aspectRatio,
    scenes: [...input.sceneSnapshots].sort((a, b) =>
      a.sceneId.localeCompare(b.sceneId)
    ),
  });
}
