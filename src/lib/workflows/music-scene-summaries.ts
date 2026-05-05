import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { MusicSceneSummary } from '@/lib/workflow/types';

/**
 * Throws when `scene.metadata` is missing rather than `||`-defaulting to
 * placeholders. Defaulting would hash-alias corrupt scenes with real
 * "Untitled Scene" / 5s values, silently keeping the music prompt's
 * input_hash matching after upstream metadata went missing.
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
