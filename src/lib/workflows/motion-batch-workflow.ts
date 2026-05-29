/**
 * Batch Motion + Music Workflow
 * Orchestrates parallel motion generation for all frames + optional music.
 * Playback and download are handled client-side by `<SequencePlayer>` /
 * the Mediabunny browser export — no server-side video merge step.
 */

import { getGenerationChannel } from '@/lib/realtime';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  BatchMotionMusicWorkflowInput,
  MotionWorkflowInput,
  MusicWorkflowInput,
} from '@/lib/workflow/types';

import { generateMotionWorkflow } from './motion-workflow';
import { generateMusicWorkflow } from './music-workflow';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'motion-batch']);

export const motionBatchWorkflow =
  createScopedWorkflow<BatchMotionMusicWorkflowInput>(
    async (context) => {
      const input = context.requestPayload;
      const { sequenceId, includeMusic } = input;
      const label = buildWorkflowLabel(sequenceId);

      if (!sequenceId) {
        throw new WorkflowValidationError('sequenceId is required');
      }
      if (!input.frames.length) {
        throw new WorkflowValidationError('At least one frame is required');
      }
      if (includeMusic && !input.music) {
        throw new WorkflowValidationError(
          'music config is required when includeMusic is true'
        );
      }

      // Invoke all motion workflows + optional music workflow in parallel.
      // The live `<SequencePlayer>` plays per-frame videos directly and the
      // browser export pipeline composes the final MP4 on the client — no
      // server-side merge step.
      const motionInvocations = input.frames.map((frame, index) =>
        context.invoke(`motion-${index}`, {
          workflow: generateMotionWorkflow,
          label,
          body: {
            userId: input.userId,
            teamId: input.teamId,
            frameId: frame.frameId,
            sequenceId,
            imageUrl: frame.imageUrl,
            prompt: frame.prompt,
            model: frame.model,
            duration: frame.duration,
            fps: frame.fps,
            motionBucket: frame.motionBucket,
            aspectRatio: frame.aspectRatio,
            generateAudio: frame.generateAudio,
            userEditedPrompt: frame.userEditedPrompt,
          } satisfies MotionWorkflowInput,
          retries: 3,
          retryDelay: 'pow(2, retried) * 1000',
        })
      );

      const musicInvocation =
        includeMusic && input.music
          ? context.invoke('music', {
              workflow: generateMusicWorkflow,
              label,
              body: {
                userId: input.userId,
                teamId: input.teamId,
                sequenceId,
                prompt: input.music.prompt,
                tags: input.music.tags,
                duration: input.music.duration,
                model: input.music.model,
              } satisfies MusicWorkflowInput,
              retries: 3,
              retryDelay: 'pow(2, retried) * 1000',
            })
          : null;

      await Promise.all([
        ...motionInvocations,
        ...(musicInvocation ? [musicInvocation] : []),
      ]);

      return { sequenceId };
    },
    {
      failureFunction: async ({ context, failResponse }) => {
        const input = context.requestPayload;
        const error = sanitizeFailResponse(failResponse);

        if (input.sequenceId) {
          try {
            await getGenerationChannel(input.sequenceId).emit(
              'generation.failed',
              { message: error }
            );
          } catch (emitError) {
            logger.error(
              `Failed to emit generation.failed for sequence ${input.sequenceId}:`,
              { err: emitError }
            );
          }
        }

        logger.error(`Failed for sequence ${input.sequenceId}: ${error}`);

        return `Batch motion+music failed for sequence ${input.sequenceId}`;
      },
    }
  );
