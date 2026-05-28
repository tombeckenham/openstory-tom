import { getGenerationChannel } from '@/lib/realtime';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult,
} from '@/lib/workflow/types';
import { computeMusicPromptInputHash } from '../ai/input-hash';
import { musicDesignResultSchema } from '../ai/response-schemas';
import { reinforceInstrumentalTags } from '../prompts/music-prompt';
import { durableLLMCall } from './llm-call-helper';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'music-prompt']);

export const generateMusicPromptWorflow = createScopedWorkflow<
  MusicPromptWorkflowInput,
  MusicPromptWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { sceneSummaries, analysisModelId, sequenceId } = input;

    const llmCallContext = {
      sequenceId,
      userId: input.userId,
      scopedDb,
    };

    const musicDesignResult: MusicPromptWorkflowResult = await durableLLMCall(
      context,
      {
        name: 'music-prompt-generation',
        phase: { number: 6, name: 'Composing music\u2026' },
        promptName: 'phase/music-design-chat',
        promptVariables: {
          scenes: JSON.stringify(sceneSummaries, null, 2),
        },
        modelId: analysisModelId,
        responseSchema: musicDesignResultSchema,
      },
      llmCallContext
    );

    if (sequenceId) {
      if (!musicDesignResult.prompt) {
        throw new Error(
          `Music prompt generation returned empty prompt for sequence ${sequenceId}`
        );
      }

      // The variants helper appends a row tagged 'ai-generated' /
      // 'regenerated' and updates the cached `musicPrompt` / `musicTags` /
      // `musicPromptInputHash` on `sequences`. The two writes are
      // sequential, not transactional — see the helper docstring.
      const inputHash = await computeMusicPromptInputHash({
        sceneSummaries,
        analysisModel: analysisModelId,
      });

      await context.run('save-music-prompt-to-db', async () => {
        const reinforcedTags = reinforceInstrumentalTags(
          musicDesignResult.tags
        );

        const previous =
          await scopedDb.sequenceMusicPromptVariants.getLatest(sequenceId);
        const source = previous ? 'regenerated' : 'ai-generated';

        await scopedDb.sequenceMusicPromptVariants.write({
          sequenceId,
          prompt: musicDesignResult.prompt,
          tags: reinforcedTags,
          source,
          inputHash,
          analysisModel: analysisModelId,
          createdBy: input.userId,
        });
      });
    }

    return musicDesignResult;
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);
      if (input.sequenceId) {
        const failSeq = scopedDb.sequence(input.sequenceId);

        await failSeq.updateMusicFields({
          musicStatus: 'failed',
          musicError: error,
        });

        try {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.audio:progress',
            { status: 'failed' }
          );
        } catch (emitError) {
          logger.error(
            `Failed to emit generation.audio:progress for sequence ${input.sequenceId}:`,
            { err: emitError }
          );
        }
      }
      logger.error('[MusicWorkflow]', {
        data: `Music generation failed for sequence ${input.sequenceId}: ${error}`,
      });
      return `Music generation failed for sequence ${input.sequenceId}`;
    },
  }
);
