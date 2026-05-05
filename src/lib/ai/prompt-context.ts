/**
 * Build the upstream context that prompt-input hashes are derived from. Used
 * by the staleness server fns and the regenerate-prompt actions so the live
 * recompute sees the same DTO shape as `visual-prompt-scene` /
 * `motion-prompt-scene` / `music-prompt` workflows.
 */

import {
  charactersToBible,
  sequenceElementsToBible,
  sequenceLocationsToBible,
} from '@/lib/ai/bibles-from-scoped';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import type {
  CharacterBibleEntry,
  ElementBibleEntry,
  LocationBibleEntry,
  Scene,
} from '@/lib/ai/scene-analysis.schema';
import type { ScopedDb } from '@/lib/db/scoped';
import type { StyleConfig } from '@/lib/db/schema';
import { StyleConfigSchema } from '@/lib/db/schema';

export type FramePromptContext = {
  scene: Scene;
  styleConfig: StyleConfig;
  characterBible: CharacterBibleEntry[];
  locationBible: LocationBibleEntry[];
  elementBible: ElementBibleEntry[];
  aspectRatio: string;
  analysisModel: string;
};

export type FramePromptContextSequence = {
  id: string;
  styleId: string | null;
  aspectRatio: string;
  analysisModel: string;
};

export async function loadFramePromptContext(args: {
  scopedDb: Pick<
    ScopedDb,
    'characters' | 'sequenceLocations' | 'sequenceElements' | 'styles'
  >;
  sequence: FramePromptContextSequence;
  scene: Scene;
  /** Override analysis model — used when a stored variant pins one. */
  analysisModelOverride?: string | null;
}): Promise<FramePromptContext> {
  const { scopedDb, sequence, scene, analysisModelOverride } = args;

  if (!sequence.styleId) {
    throw new Error(
      `Sequence ${sequence.id} has no style selected; prompt context unavailable`
    );
  }

  const [characters, locations, elements, style] = await Promise.all([
    scopedDb.characters.listWithSheets(sequence.id),
    scopedDb.sequenceLocations.listWithReferences(sequence.id),
    scopedDb.sequenceElements.list(sequence.id),
    scopedDb.styles.getById(sequence.styleId),
  ]);

  if (!style) {
    throw new Error(`Style ${sequence.styleId} not found`);
  }

  const analysisModel =
    analysisModelOverride ??
    getAnalysisModelById(sequence.analysisModel)?.id ??
    DEFAULT_ANALYSIS_MODEL;

  return {
    scene,
    styleConfig: StyleConfigSchema.parse(style.config),
    characterBible: charactersToBible(characters),
    locationBible: sequenceLocationsToBible(locations),
    elementBible: sequenceElementsToBible(elements),
    aspectRatio: sequence.aspectRatio,
    analysisModel,
  };
}
