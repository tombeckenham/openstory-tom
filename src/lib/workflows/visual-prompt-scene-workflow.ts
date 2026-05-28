/**
 * Visual Prompt Generation Workflow
 *
 * Generates visual prompts for scenes based on character bible and style config.
 * Uses three-step durable pattern: prepare → context.call → log
 */

import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { VisualPromptSceneWorkflowInput } from '@/lib/workflow/types';
import { computeVisualPromptInputHash } from '../ai/input-hash';
import { narrowFramePromptContext } from '../ai/prompt-context';
import {
  type VisualPromptWithContinuity,
  visualPromptWithContinuitySchema,
} from '../ai/scene-analysis.schema';
import { getFramePromptChannel, getGenerationChannel } from '../realtime';
import { durableStreamingLLMCall } from './llm-call-helper';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'visual-prompt-scene']);

export const visualPromptSceneWorkflow = createScopedWorkflow<
  VisualPromptSceneWorkflowInput,
  { sceneId: string } & VisualPromptWithContinuity
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
      elementBible = [],
      styleConfig,
      analysisModelId,
      frameId,
      sequenceId,
    } = input;

    // Streaming kicks in only when emitStreaming is set (force-regen path
    // from the "Regenerate Prompt" button). For script-analysis the helper
    // degrades to a plain durable call, so the auto-generation flows don't
    // pay the realtime publish cost.
    const result = await durableStreamingLLMCall(
      context,
      {
        name: 'visual-prompts',
        phase: { number: 3, name: 'Writing image prompts…' },

        promptName: 'phase/visual-prompt-scene-generation-chat',
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
          elementBible: JSON.stringify(elementBible, null, 2),
          styleConfig: JSON.stringify(styleConfig, null, 2),
          aspectRatio,
        },

        modelId: analysisModelId,
        responseSchema: visualPromptWithContinuitySchema,

        additionalMetadata: {
          frameId,
        },
      },
      {
        sequenceId,
        scopedDb,
        framePromptStream:
          input.emitStreaming && frameId
            ? { frameId, promptType: 'visual' }
            : undefined,
      }
    );

    if (sequenceId && frameId) {
      if (!result.visual.fullPrompt) {
        throw new Error(
          `Visual prompt generation returned empty fullPrompt for scene ${scene.sceneId}`
        );
      }

      const enrichedScene = {
        ...scene,
        prompts: {
          ...scene.prompts,
          visual: result.visual,
        },
        continuity: result.continuity,
      };

      // Hash inputs are narrowed by the LLM's continuity output so unreferenced
      // characters / elements / locations elsewhere in the sequence don't flip
      // this frame's hash later.
      const narrowed = narrowFramePromptContext({
        scene: enrichedScene,
        styleConfig,
        characterBible,
        locationBible,
        elementBible,
        aspectRatio,
        analysisModel: analysisModelId,
      });
      const inputHash = await computeVisualPromptInputHash(narrowed);

      await context.run('save-visual-prompt-to-db', async () => {
        const previous = await scopedDb.framePromptVariants.getLatest(
          frameId,
          'visual'
        );
        const source = previous ? 'regenerated' : 'ai-generated';

        // Clear `frame.imagePrompt` user-override when regenerating. The
        // override would otherwise mask the freshly regenerated prompt in
        // every downstream read (effective-prompt fallback chain), so a
        // regen-prompt click on a previously user-edited frame would do
        // nothing visible. The variant row above preserves the new prompt;
        // the user's prior override is still in the prompt-history sheet
        // and can be restored from there.
        await scopedDb.frames.update(frameId, {
          metadata: enrichedScene,
          imagePrompt: null,
        });

        await scopedDb.framePromptVariants.write({
          frameId,
          promptType: 'visual',
          text: result.visual.fullPrompt,
          components: result.visual.components,
          source,
          inputHash,
          analysisModel: analysisModelId,
        });

        await getGenerationChannel(sequenceId).emit(
          'generation.frame:updated',
          {
            frameId,
            updateType: 'visual-prompt',
            metadata: enrichedScene,
          }
        );

        // Signal end-of-stream to the per-frame channel so the UI can swap
        // out the streamed-deltas buffer for the persisted prompt.
        if (input.emitStreaming) {
          await getFramePromptChannel(frameId).emit('framePrompt.completed', {
            promptType: 'visual',
          });
        }
      });
    }

    return { sceneId: scene.sceneId, ...result };
  },
  {
    failureFunction: async ({ context, failStatus, failResponse }) => {
      const error = sanitizeFailResponse(failResponse);
      logger.error('Failed', {
        workflowRunId: context.workflowRunId,
        failStatus,
        failResponse: error,
      });
      // Surface the failure on the per-frame channel so an actively-viewing
      // client can clear its streaming state and toast. Best-effort — the
      // input isn't available here, so we read it off the workflow context.
      try {
        const payload = context.requestPayload;
        if (payload.emitStreaming && payload.frameId) {
          await getFramePromptChannel(payload.frameId).emit(
            'framePrompt.failed',
            { promptType: 'visual', error }
          );
        }
      } catch (emitErr) {
        logger.warn('failed to emit failure', { err: emitErr });
      }
      return `Visual prompt generation failed: ${error}`;
    },
  }
);
