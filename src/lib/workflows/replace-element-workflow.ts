/**
 * Replace Element Workflow
 *
 * Per-frame edits a sequence element across all affected frames using an
 * image edit endpoint. Unlike character/location recast (which fully
 * regenerates the frame), this swaps just the element while keeping the
 * rest of the frame intact.
 *
 * Steps:
 * 1. Re-run vision analysis on the new element image so token gets fresh
 *    description + consistencyTag (used by future scene generations).
 * 2. For each affected frame, invoke `image-workflow` with the existing
 *    frame thumbnail as PRIMARY SOURCE and the new element image as
 *    ELEMENT REF — the model edits the frame to swap the element.
 */

import { describeElementImage } from '@/lib/ai/element-vision';
import {
  DEFAULT_IMAGE_MODEL,
  safeTextToImageModel,
  supportsReferenceImages,
} from '@/lib/ai/models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import { getGenerationChannel } from '@/lib/realtime';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  ImageWorkflowInput,
  ReplaceElementWorkflowInput,
  ReplaceElementWorkflowResult,
} from '@/lib/workflow/types';
import { getFalFlowControl } from './constants';
import { generateImageWorkflow } from './image-workflow';

type FrameResult =
  | { frameId: string; success: true; imageUrl: string }
  | { frameId: string; success: false; error: string };

function buildEditPrompt(args: {
  token: string;
  newDescription: string;
  previousDescription: string | null;
}): string {
  const previous = args.previousDescription
    ? ` (previously: ${args.previousDescription})`
    : '';
  return [
    `Edit the PRIMARY SOURCE image to replace the existing ${args.token} element${previous} with the new version shown in the ELEMENT REF image.`,
    `Render the new ${args.token} naturally where the old one appeared, matching scale, perspective, lighting, and occlusion of the original placement.`,
    `Keep all other content — characters, environment, framing, camera angle, color grading, and composition — exactly as they appear in the PRIMARY SOURCE. Only the ${args.token} element should change.`,
    args.newDescription
      ? `New element description: ${args.newDescription}`
      : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export const replaceElementWorkflow = createScopedWorkflow<
  ReplaceElementWorkflowInput,
  ReplaceElementWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { sequenceId, elementId, token, affectedFrameIds, newImageUrl } =
      input;
    if (!sequenceId) {
      throw new Error('[ReplaceElementWorkflow] sequenceId is required');
    }
    const label = buildWorkflowLabel(sequenceId);

    console.log(
      '[ReplaceElementWorkflow]',
      `Starting replace for element ${token} (${elementId}) — ${affectedFrameIds.length} affected frames`
    );

    // Step 1: re-run vision on the new element image so future scene
    // generations and prompts have the correct description + consistencyTag.
    const visionResult = await context.run('describe-new-element', async () => {
      await scopedDb.sequenceElements.updateVisionStatus(
        elementId,
        'analyzing'
      );
      const openRouterApiKeyInfo =
        await scopedDb.apiKeys.resolveKey('openrouter');
      const result = await describeElementImage({
        imageUrl: newImageUrl,
        filename: input.newFilename,
        token,
        openRouterApiKey: openRouterApiKeyInfo.key,
      });
      await scopedDb.sequenceElements.updateVisionResult(
        elementId,
        result.description,
        result.consistencyTag
      );
      return result;
    });

    if (affectedFrameIds.length === 0) {
      return {
        elementId,
        framesEdited: 0,
        framesFailed: 0,
      };
    }

    await context.run('emit-start', async () => {
      await getGenerationChannel(sequenceId).emit(
        'generation.replace-element:start',
        { elementId, frameCount: affectedFrameIds.length }
      );
    });

    const sequence = await context.run('load-sequence', () =>
      scopedDb.sequences.getById(sequenceId)
    );
    if (!sequence) {
      throw new Error(
        `[ReplaceElementWorkflow] Sequence ${sequenceId} not found`
      );
    }

    const aspectRatio = sequence.aspectRatio;
    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;

    const frames = await context.run('load-frames', () =>
      scopedDb.frames.getByIds(affectedFrameIds)
    );
    if (frames.length !== affectedFrameIds.length) {
      const found = new Set(frames.map((f) => f.id));
      const missing = affectedFrameIds.filter((id) => !found.has(id));
      throw new Error(
        `[ReplaceElementWorkflow] Missing frames for element ${token}: ${missing.join(', ')}`
      );
    }

    const editPrompt = buildEditPrompt({
      token,
      newDescription: visionResult.description,
      previousDescription: input.previousDescription,
    });

    const results: FrameResult[] = await Promise.all(
      frames.map(async (frame): Promise<FrameResult> => {
        const sourceImageUrl = frame.thumbnailUrl;
        if (!sourceImageUrl) {
          // Frame has no image to edit — replacement only meaningful when a
          // primary thumbnail exists. Skip rather than fall back to text-to-
          // image, which would silently regenerate from prose.
          return {
            frameId: frame.id,
            success: false,
            error: 'no source thumbnail to edit',
          };
        }

        // Prefer the frame's existing model when it supports edits, so the
        // edit reads as a natural continuation of the original render. Fall
        // back to the workflow's chosen edit-capable model otherwise.
        const frameModel = safeTextToImageModel(
          frame.imageModel,
          DEFAULT_IMAGE_MODEL
        );
        const model = supportsReferenceImages(frameModel)
          ? frameModel
          : imageModel;

        const body: ImageWorkflowInput = {
          userId: input.userId,
          teamId: input.teamId,
          sequenceId,
          frameId: frame.id,
          prompt: editPrompt,
          model,
          imageSize: aspectRatioToImageSize(aspectRatio),
          numImages: 1,
          referenceImages: [
            {
              referenceImageUrl: sourceImageUrl,
              description: 'Existing frame to edit',
              role: 'primary',
            },
            {
              referenceImageUrl: newImageUrl,
              description: `${token} - ${visionResult.description}`,
              role: 'element',
            },
          ],
        };

        const {
          body: invokeResult,
          isFailed,
          isCanceled,
        } = await context.invoke('image', {
          workflow: generateImageWorkflow,
          label,
          body,
          retries: 3,
          retryDelay: 'pow(2, retried) * 1000',
          flowControl: getFalFlowControl(),
        });

        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (isFailed || isCanceled || !invokeResult?.imageUrl) {
          const reason = isCanceled
            ? 'canceled'
            : isFailed
              ? 'failed'
              : 'no imageUrl';
          console.error(
            '[ReplaceElementWorkflow]',
            `Image edit failed frame=${frame.id} reason=${reason}`
          );
          return {
            frameId: frame.id,
            success: false,
            error: `Image edit ${reason}`,
          };
        }

        return {
          frameId: frame.id,
          success: true,
          imageUrl: invokeResult.imageUrl,
        };
      })
    );

    const successCount = results.filter((r) => r.success).length;
    const failedCount = results.length - successCount;

    await context.run('emit-complete', async () => {
      await getGenerationChannel(sequenceId).emit(
        'generation.replace-element:complete',
        { elementId, successCount, failedCount }
      );
    });

    console.log(
      '[ReplaceElementWorkflow]',
      `Completed: ${successCount} edited, ${failedCount} failed for element ${token}`
    );

    return {
      elementId,
      framesEdited: successCount,
      framesFailed: failedCount,
    };
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      // Mark vision failed so the UI surfaces the problem on the element row;
      // the new image is already persisted so the user can retry by uploading
      // again or by triggering vision separately.
      try {
        await scopedDb.sequenceElements.updateVisionStatus(
          input.elementId,
          'failed',
          error
        );
      } catch (e) {
        console.error(
          '[ReplaceElementWorkflow] Failed to persist vision error:',
          e
        );
      }

      if (input.sequenceId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.replace-element:failed',
          { elementId: input.elementId, error }
        );
      }

      console.error(
        '[ReplaceElementWorkflow]',
        `Replace failed for element ${input.token}: ${error}`
      );

      return `Replace element failed for ${input.token}`;
    },
  }
);
