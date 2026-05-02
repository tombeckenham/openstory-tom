import { DEFAULT_IMAGE_MODEL, IMAGE_MODELS } from '@/lib/ai/models';
import { ZERO_MICROS, microsToUsd } from '@/lib/billing/money';
import { DEFAULT_IMAGE_SIZE } from '@/lib/constants/aspect-ratios';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
} from '@/lib/image/image-generation';
import { uploadImageToStorage } from '@/lib/image/image-storage';
import { buildReferenceImagePrompt } from '@/lib/prompts/reference-image-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { simpleHash } from '@/lib/utils/hash';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { ImageWorkflowInput } from '@/lib/workflow/types';
import {
  computeImageWorkflowHashCurrent,
  computeImageWorkflowHashFromDto,
} from './image-workflow-snapshot';

type ImageWorkflowResult = {
  imageUrl: string;
  frameId?: string;
  sequenceId?: string;
};

export const generateImageWorkflow = createScopedWorkflow<
  ImageWorkflowInput,
  ImageWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    // Validate the inlined snapshot inside the body. Upstash swallows
    // runStarted-middleware throws to console.error, so payload-tamper
    // detection only halts the run when the throw originates inside
    // `context.run`. Skipped when the caller did not opt into the snapshot.
    const snapshotOpted = !!input.sceneSnapshot;
    if (snapshotOpted) {
      await context.run('validate-snapshot', async () => {
        if (context.snapshot) {
          await context.snapshot.validate();
        }
      });
    }

    const generationParams = await context.run(
      'set-generating-status',
      async (): Promise<ImageGenerationParams | null> => {
        if (!input.prompt.trim()) {
          throw new WorkflowValidationError(
            'Prompt is required for image generation'
          );
        }

        console.log(
          '[ImageWorkflow]',
          `Starting image generation for user ${input.userId}`
        );

        const model = input.model ?? DEFAULT_IMAGE_MODEL;

        if (input.frameId) {
          const frame = await scopedDb.frames.update(
            input.frameId,
            {
              thumbnailStatus: 'generating',
              thumbnailWorkflowRunId: context.workflowRunId,
              imageModel: model,
              imagePrompt: input.prompt,
            },
            { throwOnMissing: false }
          );

          if (!frame) {
            console.log(
              '[ImageWorkflow]',
              `Frame ${input.frameId} was deleted, skipping`
            );
            return null;
          }

          // Dual-write: upsert frame_variants row
          if (input.sequenceId) {
            await scopedDb.frameVariants.upsert({
              frameId: input.frameId,
              sequenceId: input.sequenceId,
              variantType: 'image',
              model,
              status: 'generating',
              workflowRunId: context.workflowRunId,
            });
          }

          await getGenerationChannel(input.sequenceId).emit(
            'generation.image:progress',
            { frameId: input.frameId, status: 'generating', model }
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
            input.referenceImages?.map((ref) => ref.referenceImageUrl) ?? [],
          traceName: 'frame-image',
        } satisfies ImageGenerationParams;
      }
    );

    if (!generationParams) {
      return {
        imageUrl: '',
        frameId: input.frameId,
        sequenceId: input.sequenceId,
      } satisfies ImageWorkflowResult;
    }

    const imageResult = await context.run('generate-image', async () => {
      console.log(
        '[ImageWorkflow]',
        `Generating image ${input.frameId} with model ${generationParams.model}`
      );
      return generateImageWithProvider(generationParams, { scopedDb });
    });

    const imageCostMicros = imageResult.metadata.cost ?? ZERO_MICROS;
    const { teamId, frameId, sequenceId } = input;
    if (imageCostMicros > 0 && teamId && !imageResult.metadata.usedOwnKey) {
      await context.run('deduct-credits', async () => {
        if (!(await scopedDb.billing.hasEnoughCredits(imageCostMicros))) {
          console.warn(
            `[ImageWorkflow] Insufficient credits for team ${teamId} (cost: $${microsToUsd(imageCostMicros).toFixed(4)}), skipping deduction`
          );
          return;
        }
        await scopedDb.billing.deductCredits(imageCostMicros, {
          description: `Image generation (${generationParams.model})`,
          metadata: {
            model: generationParams.model,
            frameId: input.frameId,
            sequenceId: input.sequenceId,
          },
        });
      });
    }

    let imageUrl: string = imageResult.imageUrls[0];

    if (imageUrl && frameId && sequenceId && teamId && !input.skipStorage) {
      const writeResult = await context.run(
        'persist-result',
        async (): Promise<{ imageUrl: string } | null> => {
          const upload = await uploadImageToStorage({
            imageUrl,
            teamId,
            sequenceId,
            frameId,
          });

          if (!upload.url) {
            throw new Error('Failed to upload image to storage');
          }

          // Re-resolve current sheet hashes when the caller opted into the
          // snapshot pattern. A divergence between the trigger-time snapshot
          // and the current state means the references that produced this
          // image are no longer authoritative — preserve the result as a
          // divergent alternate instead of overwriting the primary thumbnail.
          const snapshotHash = input.snapshotInputHash;
          let divergent = false;
          if (snapshotOpted && context.snapshot && snapshotHash) {
            const currentHash = await context.snapshot.computeCurrent();
            divergent = currentHash !== snapshotHash;
          }

          if (divergent && snapshotHash) {
            // Revert the speculative primary status we set at start so the
            // primary thumbnail goes back to `pending`. The frame row never
            // held a URL (storage write happens here), so we only roll back
            // the lifecycle fields.
            const updatedFrame = await scopedDb.frames.update(
              frameId,
              {
                thumbnailStatus: 'pending',
                thumbnailWorkflowRunId: null,
                thumbnailGeneratedAt: null,
                thumbnailError: null,
                thumbnailInputHash: null,
              },
              { throwOnMissing: false }
            );

            if (!updatedFrame) {
              console.log(
                '[ImageWorkflow]',
                `Frame ${frameId} was deleted, skipping divergent write`
              );
              return null;
            }

            // Revert the speculative primary frame_variants row so the
            // primary slot stops pointing at diverged work.
            await scopedDb.frameVariants.updateByFrameAndModel(
              frameId,
              'image',
              generationParams.model,
              {
                url: null,
                storagePath: null,
                previewUrl: null,
                status: 'pending',
                workflowRunId: null,
                generatedAt: null,
                error: null,
                inputHash: null,
              }
            );

            // Insert (or no-op on retry) a divergent alternate preserving
            // the diverged result for comparison/promotion.
            const divergedAt = new Date();
            await scopedDb.frameVariants.insertDivergent({
              frameId,
              sequenceId,
              variantType: 'image',
              model: generationParams.model,
              url: upload.url,
              storagePath: upload.path || null,
              status: 'completed',
              generatedAt: divergedAt,
              error: null,
              promptHash: input.prompt ? simpleHash(input.prompt) : null,
              inputHash: snapshotHash,
              divergedAt,
            });

            await getGenerationChannel(sequenceId).emit(
              'generation.image:progress',
              { frameId, status: 'pending', model: generationParams.model }
            );

            console.log(
              '[ImageWorkflow]',
              `Diverged frame ${frameId}: snapshot=${snapshotHash.slice(0, 8)}; routed alternate to frame_variants`
            );

            return { imageUrl: upload.url };
          }

          // Convergent path (or no snapshot opted in): primary write.
          const updatedFrame = await scopedDb.frames.update(
            frameId,
            {
              thumbnailPath: upload.path || null,
              thumbnailUrl: upload.url,
              thumbnailStatus: 'completed',
              thumbnailGeneratedAt: new Date(),
              thumbnailError: null,
              thumbnailInputHash: snapshotOpted ? (snapshotHash ?? null) : null,
              videoUrl: null,
              videoPath: null,
              videoStatus: 'pending',
              videoWorkflowRunId: null,
              videoGeneratedAt: null,
              videoError: null,
            },
            { throwOnMissing: false }
          );

          if (!updatedFrame) {
            console.log(
              '[ImageWorkflow]',
              `Frame ${frameId} was deleted, skipping final update`
            );
            return null;
          }

          await scopedDb.frameVariants.updateByFrameAndModel(
            frameId,
            'image',
            generationParams.model,
            {
              url: upload.url,
              storagePath: upload.path || null,
              status: 'completed',
              generatedAt: new Date(),
              error: null,
              promptHash: input.prompt ? simpleHash(input.prompt) : null,
              inputHash: snapshotOpted ? (snapshotHash ?? null) : null,
            }
          );

          await getGenerationChannel(sequenceId).emit(
            'generation.image:progress',
            {
              frameId,
              status: 'completed',
              thumbnailUrl: upload.url,
              model: generationParams.model,
            }
          );

          console.log('[ImageWorkflow]', `Uploaded to storage: ${upload.path}`);

          return { imageUrl: upload.url };
        }
      );
      if (writeResult) imageUrl = writeResult.imageUrl;
    } else if (imageUrl && frameId && input.skipStorage) {
      // Preview mode: store fal.ai CDN URL in dedicated preview field
      await context.run('store-preview-url', async () => {
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
          console.log(
            '[ImageWorkflow]',
            `Frame ${frameId} was deleted, skipping preview update`
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

    console.log('[ImageWorkflow]', 'Image generation workflow completed');

    return { imageUrl, frameId, sequenceId };
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      // Skipping storage means we're in preview mode
      const previewMode = input.skipStorage;
      if (!previewMode) {
        // Only flag the frame as failed if we're not in preview mode
        const error = sanitizeFailResponse(failResponse);

        if (input.frameId && input.teamId) {
          await scopedDb.frames.update(
            input.frameId,
            { thumbnailStatus: 'failed', thumbnailError: error },
            { throwOnMissing: false }
          );

          // Dual-write: update frame_variants row (returns null if row doesn't exist)
          const model = input.model ?? DEFAULT_IMAGE_MODEL;
          if (input.sequenceId) {
            await scopedDb.frameVariants.updateByFrameAndModel(
              input.frameId,
              'image',
              model,
              { status: 'failed', error }
            );
          }

          if (input.sequenceId) {
            try {
              await getGenerationChannel(input.sequenceId).emit(
                'generation.image:progress',
                { frameId: input.frameId, status: 'failed', model }
              );
            } catch {
              // Ignore emit errors in failure handler
            }
          }
        }

        console.error(
          '[ImageWorkflow]',
          `Image generation failed for frame ${input.frameId}: ${error}`
        );
      }

      return `Image generation failed for frame ${input.frameId}`;
    },
    snapshot: {
      computeFromDto: (input) => computeImageWorkflowHashFromDto(input),
      computeCurrent: (input, scopedDb) =>
        computeImageWorkflowHashCurrent(input, scopedDb),
    },
  }
);
