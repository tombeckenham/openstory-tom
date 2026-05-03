/**
 * Motion Prompt Scene Workflow
 *
 * Generates motion prompts for a single scene based on character bible and style config.
 * Uses three-step durable pattern: prepare → context.call → log
 */

import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { MotionPromptSceneWorkflowInput } from '@/lib/workflow/types';
import { computeMotionPromptInputHash } from '../ai/input-hash';
import {
  type MotionPrompt,
  motionPromptSchema,
} from '../ai/scene-analysis.schema';
import { durableLLMCall } from './llm-call-helper';

export const motionPromptSceneWorkflow = createScopedWorkflow<
  MotionPromptSceneWorkflowInput,
  { sceneId: string; motionPrompt: MotionPrompt }
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const {
      scene,
      sceneBefore,
      sceneAfter,
      aspectRatio,
      characterBible,
      locationBible,
      styleConfig,
      analysisModelId,
      sequenceId,
      frameId,
    } = input;

    console.log(
      `[MotionPromptSceneWorkflow] Generating motion prompt for scene ${scene.sceneId}`
    );

    // ============================================================
    // PHASE 3: Motion Prompt Generation (using durableLLMCall helper)
    // ============================================================

    const { promptVariables, additionalMetadata } = await context.run(
      'prepare-motion-prompt-generation',
      async () => {
        return {
          promptVariables: {
            sceneBefore: sceneBefore
              ? JSON.stringify(sceneBefore, null, 2)
              : '(none)',
            sceneAfter: sceneAfter
              ? JSON.stringify(sceneAfter, null, 2)
              : '(none)',
            scene: JSON.stringify(scene, null, 2),
            characterBible: JSON.stringify(characterBible, null, 2),
            locationBible: JSON.stringify(locationBible, null, 2),
            styleConfig: JSON.stringify(styleConfig, null, 2),
            aspectRatio,
          },
          additionalMetadata: {
            frameId,
          },
        };
      }
    );
    const motionPrompt = await durableLLMCall(
      context,
      {
        name: 'motion-prompts',
        phase: { number: 5, name: 'Writing motion prompts…' },

        promptName: 'phase/motion-prompt-scene-generation-chat',
        promptVariables,

        modelId: analysisModelId,
        responseSchema: motionPromptSchema,

        additionalMetadata,
      },
      {
        sequenceId,
        scopedDb,
      }
    );

    if (sequenceId && frameId) {
      await context.run('save-motion-prompt-to-db', async () => {
        await scopedDb.frames.update(frameId, { metadata: scene });

        if (motionPrompt.fullPrompt) {
          const inputHash = await computeMotionPromptInputHash({
            scene,
            styleConfig,
            characterBible,
            locationBible,
            aspectRatio,
            analysisModel: analysisModelId,
          });

          const previous = await scopedDb.framePromptVariants.getLatest(
            frameId,
            'motion'
          );
          const source = previous ? 'regenerated' : 'ai-generated';

          await scopedDb.framePromptVariants.write({
            frameId,
            promptType: 'motion',
            text: motionPrompt.fullPrompt,
            components: motionPrompt.components ?? null,
            parameters: motionPrompt.parameters ?? null,
            source,
            inputHash,
            analysisModel: analysisModelId,
          });
        }
      });
    }
    return { sceneId: scene.sceneId, motionPrompt };
  },
  {
    failureFunction: async () => {
      return `Motion prompt generation failed`;
    },
  }
);
