import type { Scene } from '@/lib/ai/scene-analysis.schema';
import type { MusicSceneSummary } from '@/lib/workflow/types';

/**
 * Reduce scenes to the compact summaries fed to the music-prompt LLM. Pulled
 * out so the music-prompt staleness check and the music-prompt regenerate
 * action can hash identical inputs to the workflow.
 */
export function buildMusicSceneSummaries(
  scenes: readonly Scene[]
): MusicSceneSummary[] {
  return scenes.map((scene) => ({
    sceneId: scene.sceneId,
    title: scene.metadata?.title || 'Untitled Scene',
    storyBeat: scene.metadata?.storyBeat || '',
    durationSeconds: scene.metadata?.durationSeconds || 5,
    location: scene.metadata?.location || '',
    timeOfDay: scene.metadata?.timeOfDay || '',
    visualSummary: scene.prompts?.visual?.components.atmosphere || '',
  }));
}
