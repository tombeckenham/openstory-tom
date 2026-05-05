import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { MusicSceneSummary } from '@/lib/workflow/types';

/**
 * Reduce scenes to the compact summaries fed to the music-prompt LLM. Pulled
 * out so the music-prompt staleness check and the music-prompt regenerate
 * action can hash identical inputs to the workflow.
 *
 * Throws when a scene is missing `metadata` rather than `||`-defaulting to
 * placeholders. The defaults would hash-alias real "Untitled Scene" / 5s
 * values with corrupt-data scenes, which would silently keep the music
 * prompt's `input_hash` matching even after upstream metadata went missing.
 * `sceneMetadataSchema` already provides per-field `.catch()` defaults, so a
 * present `metadata` is guaranteed to have every field populated — only the
 * outer `metadata: undefined` case needs to fail loudly here.
 */
export function buildMusicSceneSummaries(
  scenes: readonly Scene[]
): MusicSceneSummary[] {
  return scenes.map((scene) => {
    if (!scene.metadata) {
      throw new Error(
        `Scene ${scene.sceneId} is missing metadata; cannot build music scene summary`
      );
    }
    return {
      sceneId: scene.sceneId,
      title: scene.metadata.title,
      storyBeat: scene.metadata.storyBeat,
      durationSeconds: scene.metadata.durationSeconds,
      location: scene.metadata.location,
      timeOfDay: scene.metadata.timeOfDay,
      visualSummary: scene.prompts?.visual?.components.atmosphere ?? '',
    };
  });
}
