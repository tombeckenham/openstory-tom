/**
 * Cloudflare Workflows port of `generateImageWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/image-workflow.ts`) step
 * for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - Calls the snapshot DTO computers directly instead of going through
 *     the `context.snapshot.*` extension. */

import { computeVisualPromptInputHash } from '@/lib/ai/input-hash';
import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import { loadNarrowFramePromptContext } from '@/lib/ai/prompt-context';
import { ZERO_MICROS } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import { DEFAULT_IMAGE_SIZE } from '@/lib/constants/aspect-ratios';
import type { ScopedDb } from '@/lib/db/scoped';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import {
  CONTENT_REJECTION_RETRY_EVENT,
  isContentRejectionError,
} from '@/lib/ai/content-rejection';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
  type ImageGenerationResult,
} from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { simpleHash } from '@/lib/utils/hash';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { NonRetryableError } from 'cloudflare:workflows';
import type { ImageWorkflowInput } from '@/lib/workflow/types';
import type { ReferenceImageDescription } from '@/lib/prompts/reference-image-prompt';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import {
  computeImageWorkflowHashCurrent,
  computeImageWorkflowHashFromDto,
  persistImageResult,
} from '@/lib/workflows/image-workflow-snapshot';
import { shouldRecordUserEdit } from '@/lib/workflows/user-edit-predicate';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'image']);

/**
 * Total primary-image generation attempts on a content-flag rejection (#881):
 * the initial attempt plus 2 retries. Stochastic provider rejections usually
 * clear on a fresh call; deterministic content-checker hits exhaust this budget
 * and fail as before.
 */
const MAX_IMAGE_ATTEMPTS = 3;

type ImageWorkflowResult = {
  imageUrl: string;
  frameId?: string;
  sequenceId?: string;
};

export class ImageWorkflow extends OpenStoryWorkflowEntrypoint<ImageWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<ImageWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<ImageWorkflowResult> {
    const input = event.payload;
    const workflowRunId = event.instanceId;

    if (input.sceneSnapshot) {
      await step.do('validate-snapshot', async () => {
        const expected = input.snapshotInputHash ?? '';
        const recomputed = await computeImageWorkflowHashFromDto(input);
        if (recomputed !== expected) {
          throw new WorkflowValidationError(
            'snapshotInputHash does not match the inlined DTO; payload was tampered with or serialized inconsistently'
          );
        }
      });
    }

    const snapshotHash: string | null =
      input.sceneSnapshot && input.snapshotInputHash
        ? input.snapshotInputHash
        : null;

    const generationParams = await step.do(
      'set-generating-status',
      async (): Promise<ImageGenerationParams | null> => {
        if (!input.prompt.trim()) {
          throw new WorkflowValidationError(
            'Prompt is required for image generation'
          );
        }

        logger.info(
          `[ImageWorkflow:cf] Starting image generation for user ${input.userId}`
        );

        const model = input.model ?? DEFAULT_IMAGE_MODEL;

        if (input.frameId) {
          // Variant-only (#547) must not touch the live primary columns — read
          // the frame instead of stamping `imageModel`/`thumbnailStatus`, so
          // adding a model can't flip the primary or trip staleness. The
          // per-model `frame_variants` row (opened below) carries the in-flight
          // state instead.
          const frame = input.variantOnly
            ? await scopedDb.frames.getById(input.frameId)
            : await scopedDb.frames.update(
                input.frameId,
                {
                  thumbnailStatus: 'generating',
                  thumbnailWorkflowRunId: workflowRunId,
                  imageModel: model,
                },
                { throwOnMissing: false }
              );

          if (!frame) {
            logger.info(
              `[ImageWorkflow:cf] Frame ${input.frameId} was deleted, skipping`
            );
            return null;
          }

          if (
            shouldRecordUserEdit({
              userEditedPrompt: input.userEditedPrompt,
              prompt: input.prompt,
              currentPrompt: frame.imagePrompt,
            })
          ) {
            let userEditInputHash: string | null = null;
            let userEditAnalysisModel: string | null = null;
            try {
              if (frame.metadata && input.sequenceId) {
                const sequence = await scopedDb.sequences.getById(
                  input.sequenceId
                );
                if (sequence) {
                  const ctx = await loadNarrowFramePromptContext({
                    scopedDb,
                    sequence: {
                      id: sequence.id,
                      styleId: sequence.styleId,
                      aspectRatio: sequence.aspectRatio,
                      analysisModel: sequence.analysisModel,
                    },
                    scene: frame.metadata,
                  });
                  userEditInputHash = await computeVisualPromptInputHash(ctx);
                  userEditAnalysisModel = ctx.analysisModel;
                }
              }
            } catch (err) {
              logger.warn(
                `[ImageWorkflow:cf] Could not compute upstream hash for user-edit on frame ${input.frameId}; recording with null hash`,
                {
                  err,
                }
              );
            }

            await scopedDb.framePromptVariants.write({
              frameId: input.frameId,
              promptType: 'visual',
              text: input.prompt,
              source: 'user-edit',
              inputHash: userEditInputHash,
              analysisModel: userEditAnalysisModel,
              createdBy: input.userId,
            });
          }

          if (input.sequenceId) {
            await scopedDb.frameVariants.upsert({
              frameId: input.frameId,
              sequenceId: input.sequenceId,
              variantType: 'image',
              model,
              status: 'generating',
              workflowRunId,
            });
          }

          await getGenerationChannel(input.sequenceId).emit(
            'generation.image:progress',
            {
              frameId: input.frameId,
              status: 'generating',
              model,
              // Variant-only (#547): don't flip the primary frame to
              // "generating" in cache — this run only fills a variant row.
              variantOnly: input.variantOnly,
            }
          );
        }

        return {
          model,
          prompt: buildReferenceImagePrompt(
            input.prompt,
            input.referenceImages ?? [],
            IMAGE_MODELS[model].maxPromptLength
          ).prompt,
          imageSize: input.imageSize ?? DEFAULT_IMAGE_SIZE,
          numImages: input.numImages ?? 1,
          seed: input.seed,
          referenceImageUrls:
            input.referenceImages?.map(
              (ref: ReferenceImageDescription) => ref.referenceImageUrl
            ) ?? [],
          traceName: 'frame-image',
        } satisfies ImageGenerationParams;
      }
    );

    if (!generationParams) {
      return {
        imageUrl: '',
        frameId: input.frameId,
        sequenceId: input.sequenceId,
      };
    }

    // Generate with a bounded same-model retry on content-flag rejections
    // (#881). Each attempt is its own durable step — a fresh model call. A
    // content rejection is caught INSIDE the step and surfaced as a sentinel
    // (not thrown) so CF's per-step retry machinery doesn't fire on it — the
    // loop owns the retry. Genuine transient errors still throw out of the step
    // and lean on CF's per-step retries as before.
    let imageResult: ImageGenerationResult | null = null;
    let lastRejection: string | null = null;
    for (let attempt = 0; attempt < MAX_IMAGE_ATTEMPTS; attempt++) {
      const stepName =
        attempt === 0 ? 'generate-image' : `generate-image-retry-${attempt}`;

      const outcome = await step.do(stepName, async () => {
        logger.info(
          `[ImageWorkflow:cf] Generating image ${input.frameId} with model ${generationParams.model} (attempt ${attempt + 1}/${MAX_IMAGE_ATTEMPTS})`
        );
        try {
          const result = await generateImageWithProvider(generationParams, {
            scopedDb,
          });
          return { ok: true as const, result };
        } catch (error) {
          if (isContentRejectionError(error)) {
            return {
              ok: false as const,
              rejection: extractFalErrorMessage(error),
            };
          }
          throw error;
        }
      });

      if (outcome.ok) {
        imageResult = outcome.result;
        if (attempt > 0) {
          logger.info(
            `[ImageWorkflow:cf] content-flag retry rescued image for frame ${input.frameId} on attempt ${attempt + 1}`,
            {
              event: CONTENT_REJECTION_RETRY_EVENT,
              outcome: 'rescued',
              kind: 'image',
              model: generationParams.model,
              attempts: attempt + 1,
              frameId: input.frameId,
              sequenceId: input.sequenceId,
            }
          );
        }
        break;
      }

      lastRejection = outcome.rejection;
      logger.warn(
        `[ImageWorkflow:cf] content-flag rejection on attempt ${attempt + 1}/${MAX_IMAGE_ATTEMPTS} for frame ${input.frameId}: ${outcome.rejection}`
      );
    }

    if (!imageResult) {
      logger.error(
        `[ImageWorkflow:cf] content-flag retry exhausted for frame ${input.frameId} after ${MAX_IMAGE_ATTEMPTS} attempts`,
        {
          event: CONTENT_REJECTION_RETRY_EVENT,
          outcome: 'exhausted',
          kind: 'image',
          model: generationParams.model,
          attempts: MAX_IMAGE_ATTEMPTS,
          frameId: input.frameId,
          sequenceId: input.sequenceId,
          rejection: lastRejection,
        }
      );
      throw new NonRetryableError(
        `Image generation rejected by content filter after ${MAX_IMAGE_ATTEMPTS} attempts: ${lastRejection ?? 'unknown rejection'}`,
        'ContentRejectionExhausted'
      );
    }

    const imageCostMicros = imageResult.metadata.cost ?? ZERO_MICROS;
    const { teamId, frameId, sequenceId } = input;
    if (imageCostMicros > 0 && teamId && !imageResult.metadata.usedOwnKey) {
      await step.do('deduct-credits', async () => {
        await deductWorkflowCredits({
          scopedDb,
          costMicros: imageCostMicros,
          usedOwnKey: imageResult.metadata.usedOwnKey,
          description: `Image generation (${generationParams.model})`,
          idempotencyKey: `${event.instanceId}:image`,
          metadata: {
            model: generationParams.model,
            frameId: input.frameId,
            sequenceId: input.sequenceId,
          },
          workflowName: 'ImageWorkflow:cf',
        });
      });
    }

    const generatedImageUrl = imageResult.imageUrls[0];
    if (!generatedImageUrl) {
      throw new Error('Image generation did not return any image URLs');
    }
    let imageUrl: string = generatedImageUrl;

    if (imageUrl && frameId && sequenceId && teamId && !input.skipStorage) {
      const upload = await step.do('upload-image', async () => {
        return uploadImageToStorage({
          imageUrl,
          teamId,
          sequenceId,
          frameId,
        });
      });

      const writeResult = await step.do('persist-result', async () => {
        const promptHash = input.prompt ? simpleHash(input.prompt) : null;
        const { model } = generationParams;

        const currentHash = snapshotHash
          ? await computeImageWorkflowHashCurrent(input, scopedDb)
          : null;

        const outcome = await persistImageResult({
          scopedDb,
          frameId,
          sequenceId,
          model,
          upload,
          snapshotHash,
          currentHash,
          promptHash,
          variantOnly: input.variantOnly,
          emit: async (event2, payload) => {
            await getGenerationChannel(sequenceId).emit(event2, payload);
          },
        });

        if (outcome.status === 'frame-deleted') {
          logger.info(
            `[ImageWorkflow:cf] Frame ${frameId} was deleted, skipping persist`
          );
          return null;
        }

        if (outcome.status === 'divergent' && snapshotHash) {
          logger.info(
            `[ImageWorkflow:cf] Diverged frame ${frameId}: snapshot=${snapshotHash.slice(0, 8)} current=${currentHash?.slice(0, 8)}; routed alternate to frame_variants`
          );
        } else {
          logger.info(`[ImageWorkflow:cf] Uploaded to storage: ${upload.path}`);
        }

        return { imageUrl: outcome.imageUrl };
      });
      if (writeResult) imageUrl = writeResult.imageUrl;
    } else if (imageUrl && frameId && input.skipStorage) {
      await step.do('store-preview-url', async () => {
        const updatedFrame = await scopedDb.frames.update(
          frameId,
          {
            previewThumbnailUrl: imageUrl,
            thumbnailGeneratedAt: new Date(),
            thumbnailError: null,
          },
          { throwOnMissing: false }
        );

        if (!updatedFrame) {
          logger.info(
            `[ImageWorkflow:cf] Frame ${frameId} was deleted, skipping preview update`
          );
          return;
        }

        if (sequenceId) {
          await getGenerationChannel(sequenceId).emit(
            'generation.image:progress',
            { frameId, previewThumbnailUrl: imageUrl }
          );
        }
      });
    }

    return { imageUrl, frameId, sequenceId };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<ImageWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;
    const previewMode = input.skipStorage;
    if (previewMode) return;

    if (!input.frameId || !input.teamId) return;

    // Variant-only (#547): leave the primary columns untouched on failure too —
    // only this model's variant row is flipped to `failed` below.
    if (!input.variantOnly) {
      await scopedDb.frames.update(
        input.frameId,
        { thumbnailStatus: 'failed', thumbnailError: error },
        { throwOnMissing: false }
      );
    }

    const model = input.model ?? DEFAULT_IMAGE_MODEL;
    if (input.sequenceId) {
      await scopedDb.frameVariants.updateByFrameAndModel(
        input.frameId,
        'image',
        model,
        { status: 'failed', error }
      );

      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.image:progress',
          {
            frameId: input.frameId,
            status: 'failed',
            model,
            // Carry the reason so the cache updater writes `thumbnailError`
            // live — otherwise the FailureSummaryBanner shows "Unknown error"
            // until a full refetch (#881). Skip for variant-only (the primary
            // row isn't touched).
            ...(input.variantOnly ? {} : { error }),
            // Variant-only (#547): a failed alternate must not flip the primary
            // thumbnail to "failed" in cache (the DB write above is already
            // guarded on variantOnly).
            variantOnly: input.variantOnly,
          }
        );
      } catch (emitError) {
        logger.error(
          `[ImageWorkflow:cf] Failed to emit failure event for sequence ${input.sequenceId} frame ${input.frameId}:`,
          {
            err: emitError,
          }
        );
      }
    }

    logger.error(
      `[ImageWorkflow:cf] Image generation failed for frame ${input.frameId}: ${error}`
    );
  }
}
