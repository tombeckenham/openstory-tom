/**
 * Canonical SHA-256 hashing of artifact input DTOs for staleness detection.
 *
 * Each helper accepts the minimal input DTO for one artifact type (never a
 * whole DB row) and returns a hex SHA-256 digest. A stored hash that no longer
 * matches a freshly computed one means the inputs that produced the artifact
 * have changed — the artifact is stale.
 *
 * The existing `simpleHash` in `src/lib/utils/hash.ts` is a 32-bit
 * non-cryptographic hash used for prompt-change detection. It is not
 * collision-resistant and not appropriate for cross-entity dependency
 * tracking, hence this separate module.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "What goes into the hash" for the per-artifact input surface.
 */

/**
 * Recursively rebuild a value with object keys sorted. Arrays are preserved in
 * order — set-like fields are sorted by the per-helper DTO before being passed
 * in, so this layer treats every array as ordered.
 *
 * Throws on values that JSON.stringify would silently elide or coerce
 * (`undefined`, functions, symbols, `NaN`, `±Infinity`) — those would produce
 * hash collisions across semantically distinct inputs. Callers must normalize
 * `undefined` optionals to `null` (or use `trim()` for free-text fields, which
 * coerces nullish to `''`) before passing in.
 */
function canonicalize(
  value: unknown,
  seen: WeakSet<object> = new WeakSet()
): unknown {
  if (value === undefined) {
    throw new Error(
      'input-hash: undefined is not hashable; use null explicitly'
    );
  }
  if (typeof value === 'function' || typeof value === 'symbol') {
    throw new Error(`input-hash: ${typeof value} is not hashable`);
  }
  if (typeof value === 'number' && !Number.isFinite(value)) {
    throw new Error(`input-hash: non-finite number ${value} is not hashable`);
  }
  if (Array.isArray(value)) {
    return value.map((v) => canonicalize(v, seen));
  }
  if (value !== null && typeof value === 'object') {
    if (seen.has(value)) {
      throw new Error('input-hash: circular reference in DTO');
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0
    )) {
      out[key] = canonicalize(val, seen);
    }
    return out;
  }
  return value;
}

const encoder = new TextEncoder();

export async function sha256Hex(input: unknown): Promise<string> {
  const json = JSON.stringify(canonicalize(input));
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(json));
  const bytes = new Uint8Array(digest);
  let hex = '';
  for (const b of bytes) {
    hex += b.toString(16).padStart(2, '0');
  }
  return hex;
}

const trim = (s: string | null | undefined): string => (s ?? '').trim();

/** Sort an unordered set of strings so the hash is order-insensitive. */
const sortedRefs = (refs: readonly string[] | undefined): string[] =>
  [...(refs ?? [])].sort();

type FrameImageHashFields = {
  visualPrompt: string;
  imageModel: string;
  aspectRatio: string;
  size?: string | null;
  seed?: number | null;
  characterSheetHashes: readonly string[];
  locationSheetHashes: readonly string[];
  elementReferenceHashes: readonly string[];
};

export type FrameImageHashKind = 'thumbnail' | 'variant-image';

export type FrameImageHashInput = FrameImageHashFields & {
  kind: FrameImageHashKind;
};

export function computeFrameImageInputHash(
  input: FrameImageHashInput
): Promise<string> {
  return sha256Hex({
    artifact: `frame:${input.kind}`,
    visualPrompt: trim(input.visualPrompt),
    imageModel: input.imageModel,
    aspectRatio: input.aspectRatio,
    size: input.size ?? null,
    seed: input.seed ?? null,
    characterSheetHashes: sortedRefs(input.characterSheetHashes),
    locationSheetHashes: sortedRefs(input.locationSheetHashes),
    elementReferenceHashes: sortedRefs(input.elementReferenceHashes),
  });
}

/**
 * Source the video was derived from. A `variantHash` references the prior
 * artifact-hash chain (so a stale upstream image cascades); a `url` is used
 * when the source is an external asset with no hashable upstream.
 */
export type FrameVideoSourceImage =
  | { kind: 'variantHash'; hash: string }
  | { kind: 'url'; url: string };

export type FrameVideoHashInput = {
  sourceImage: FrameVideoSourceImage;
  motionPrompt: string;
  motionModel: string;
  durationSeconds: number;
  fps?: number | null;
  aspectRatio: string;
};

export function computeFrameVideoInputHash(
  input: FrameVideoHashInput
): Promise<string> {
  const sourceImage =
    input.sourceImage.kind === 'variantHash'
      ? { kind: 'variantHash' as const, hash: trim(input.sourceImage.hash) }
      : { kind: 'url' as const, url: trim(input.sourceImage.url) };
  return sha256Hex({
    artifact: 'frame:video',
    sourceImage,
    motionPrompt: trim(input.motionPrompt),
    motionModel: input.motionModel,
    durationSeconds: input.durationSeconds,
    fps: input.fps ?? null,
    aspectRatio: input.aspectRatio,
  });
}

export type FrameAudioHashInput = {
  musicPrompt: string;
  /** Unordered set of music tags. */
  tags: readonly string[];
  durationSeconds: number;
  audioModel: string;
};

export function computeFrameAudioInputHash(
  input: FrameAudioHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'frame:audio',
    musicPrompt: trim(input.musicPrompt),
    tags: sortedRefs(input.tags),
    durationSeconds: input.durationSeconds,
    audioModel: input.audioModel,
  });
}

export type CharacterBibleHashFields = {
  name: string;
  age: string;
  gender?: string | null;
  ethnicity?: string | null;
  physicalDescription?: string | null;
  standardClothing?: string | null;
  distinguishingFeatures?: string | null;
  consistencyTag?: string | null;
};

export type CharacterSheetHashInput = {
  characterBible: CharacterBibleHashFields;
  talentSheetHash?: string | null;
  styleConfigHash: string;
  imageModel: string;
};

export function computeCharacterSheetInputHash(
  input: CharacterSheetHashInput
): Promise<string> {
  const cb = input.characterBible;
  return sha256Hex({
    artifact: 'character:sheet',
    characterBible: {
      name: trim(cb.name),
      age: trim(cb.age),
      gender: trim(cb.gender),
      ethnicity: trim(cb.ethnicity),
      physicalDescription: trim(cb.physicalDescription),
      standardClothing: trim(cb.standardClothing),
      distinguishingFeatures: trim(cb.distinguishingFeatures),
      consistencyTag: trim(cb.consistencyTag),
    },
    talentSheetHash: input.talentSheetHash ?? null,
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  });
}

export type LocationBibleHashFields = {
  name: string;
  description?: string | null;
};

export type LocationSheetHashInput = {
  locationBible: LocationBibleHashFields;
  /** Hash of the parent library location's reference image, if any. */
  libraryLocationReferenceHash?: string | null;
  styleConfigHash: string;
  imageModel: string;
};

export function computeLocationSheetInputHash(
  input: LocationSheetHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'location:sheet',
    locationBible: {
      name: trim(input.locationBible.name),
      description: trim(input.locationBible.description),
    },
    libraryLocationReferenceHash: input.libraryLocationReferenceHash ?? null,
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  });
}

export type LibraryLocationReferenceHashInput = {
  locationBible: LocationBibleHashFields;
  styleConfigHash: string;
  imageModel: string;
};

export function computeLibraryLocationReferenceInputHash(
  input: LibraryLocationReferenceHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'library-location:reference',
    locationBible: {
      name: trim(input.locationBible.name),
      description: trim(input.locationBible.description),
    },
    styleConfigHash: input.styleConfigHash,
    imageModel: input.imageModel,
  });
}

export type TalentSheetHashInput = {
  talent: {
    name: string;
    description?: string | null;
  };
  /** Unordered set of reference media hashes (talent_media rows). */
  referenceMediaHashes: readonly string[];
  imageModel: string;
};

export function computeTalentSheetInputHash(
  input: TalentSheetHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'talent:sheet',
    talent: {
      name: trim(input.talent.name),
      description: trim(input.talent.description),
    },
    referenceMediaHashes: sortedRefs(input.referenceMediaHashes),
    imageModel: input.imageModel,
  });
}

// ---------------------------------------------------------------------------
// Prompt input hashes
//
// Prompts are themselves AI-generated artifacts. The hash captures only the
// upstream context the LLM was given — scene metadata, style config,
// character / location / element bibles, aspect ratio, and the analysis
// model. The LLM's output (`scene.prompts`, `scene.continuity`) is
// deliberately excluded; including it would make every regeneration produce a
// different hash for identical inputs, since LLM output is non-deterministic.
// ---------------------------------------------------------------------------

import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from './scene-analysis.schema';
import type { MusicSceneSummary } from '@/lib/workflow/types';
import type { StyleConfig } from '@/lib/db/schema';

export type PromptSceneContextHashInput = {
  /**
   * Scene the prompt is being generated for. `prompts` and `continuity` are
   * stripped before hashing — they are downstream LLM output, not input.
   */
  scene: Scene;
  /** Sequence style config (look/feel knobs that influence prompt phrasing). */
  styleConfig: StyleConfig;
  /** Character bible entries; order is preserved (scene-defined ordering). */
  characterBible: readonly CharacterBibleEntry[];
  /** Location bible entries; order is preserved. */
  locationBible: readonly LocationBibleEntry[];
  /** Element bible entries; order is preserved. */
  elementBible?: readonly ElementBibleEntry[];
  /** Aspect ratio influences composition guidance in the prompt. */
  aspectRatio: string;
  /** Analysis model id (e.g. `anthropic/claude-haiku-4.5`). */
  analysisModel: string;
};

/**
 * Strip the LLM-output fields off a scene so the hash represents only the
 * pre-prompt input surface.
 */
function sceneInputContext(
  scene: Scene
): Omit<Scene, 'prompts' | 'continuity'> {
  const { prompts: _prompts, continuity: _continuity, ...context } = scene;
  return context;
}

export function computeVisualPromptInputHash(
  input: PromptSceneContextHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'frame:visual-prompt',
    scene: sceneInputContext(input.scene),
    styleConfig: input.styleConfig,
    characterBible: input.characterBible,
    locationBible: input.locationBible,
    elementBible: input.elementBible ?? null,
    aspectRatio: trim(input.aspectRatio),
    analysisModel: trim(input.analysisModel),
  });
}

export function computeMotionPromptInputHash(
  input: PromptSceneContextHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'frame:motion-prompt',
    scene: sceneInputContext(input.scene),
    styleConfig: input.styleConfig,
    characterBible: input.characterBible,
    locationBible: input.locationBible,
    elementBible: input.elementBible ?? null,
    aspectRatio: trim(input.aspectRatio),
    analysisModel: trim(input.analysisModel),
  });
}

export type MusicPromptInputHashInput = {
  /** Compact scene summaries fed to the music LLM — the actual upstream input. */
  sceneSummaries: readonly MusicSceneSummary[];
  analysisModel: string;
};

export function computeMusicPromptInputHash(
  input: MusicPromptInputHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'sequence:music-prompt',
    sceneSummaries: input.sceneSummaries,
    analysisModel: trim(input.analysisModel),
  });
}

/**
 * One source frame video in the stitch order. A `variantHash` references the
 * prior frame-video artifact chain (so a stale upstream frame cascades); a
 * `url` is used when the source is an external asset with no hashable
 * upstream.
 */
export type SequenceVideoFrameSource =
  | { kind: 'variantHash'; hash: string }
  | { kind: 'url'; url: string };

export type SequenceVideoHashInput = {
  /**
   * Ordered list of source frame videos in stitch order. Each entry is
   * either a `variantHash` (cascading from the upstream frame-video
   * artifact) or a `url` (external asset with no hashable upstream).
   */
  sourceFrameVideos: readonly SequenceVideoFrameSource[];
  targetFps?: number | null;
  resolution?: { width: number; height: number } | null;
};

export function computeSequenceVideoInputHash(
  input: SequenceVideoHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'sequence:video',
    // Order is meaningful — this is the ordered stitch list, not a set.
    sourceFrameVideos: input.sourceFrameVideos.map((src) =>
      src.kind === 'variantHash'
        ? { kind: 'variantHash' as const, hash: trim(src.hash) }
        : { kind: 'url' as const, url: trim(src.url) }
    ),
    targetFps: input.targetFps ?? null,
    resolution: input.resolution
      ? { width: input.resolution.width, height: input.resolution.height }
      : null,
  });
}

export type SequenceMusicHashInput = {
  prompt: string;
  /** Tag string (comma-joined, as stored on `sequences.musicTags`). */
  tags: string;
  durationSeconds: number;
  audioModel: string;
};

export function computeSequenceMusicInputHash(
  input: SequenceMusicHashInput
): Promise<string> {
  return sha256Hex({
    artifact: 'sequence:music',
    prompt: trim(input.prompt),
    tags: trim(input.tags),
    durationSeconds: input.durationSeconds,
    audioModel: input.audioModel,
  });
}
