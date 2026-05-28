/**
 * Library Location Sheet Generation Workflow
 *
 * Generates a 3x3 grid reference sheet for library locations based on
 * user-uploaded reference images, plus a preview establishing shot
 * for the location card thumbnail.
 */

import { uploadResponse } from '@/lib/storage/upload-response';
import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import {
  deductWorkflowCredits,
  extractImageCost,
} from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import {
  generateImageWithProvider,
  type ImageGenerationParams,
} from '@/lib/image/image-generation';
import {
  buildLibraryLocationSheetPrompt,
  buildLocationPreviewPrompt,
} from '@/lib/prompts/location-prompt';
import { getLocationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'library-location-sheet']);

import type {
  LibraryLocationSheetWorkflowInput,
  LibraryLocationSheetWorkflowResult,
} from '@/lib/workflow/types';

export const libraryLocationSheetWorkflow = createScopedWorkflow<
  LibraryLocationSheetWorkflowInput,
  LibraryLocationSheetWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    // Emit generating status
    await context.run('emit-generating', async () => {
      await getLocationChannel(input.locationDbId).emit(
        'location.sheet:progress',
        {
          locationId: input.locationDbId,
          status: 'generating',
        }
      );
    });

    // Step 1: Build the prompt
    const generationParams: ImageGenerationParams = await context.run(
      'build-prompt',
      async () => {
        logger.info('[LibraryLocationSheetWorkflow]', {
          data: `Starting sheet generation for location ${input.locationName} with ${input.referenceImageUrls.length} reference images`,
        });

        const { prompt, referenceUrls } = buildLibraryLocationSheetPrompt(
          input.locationName,
          input.locationDescription,
          input.referenceImageUrls
        );

        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // 3x3 grid in landscape format
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
          traceName: 'library-location-sheet',
        } satisfies ImageGenerationParams;
      }
    );

    // Step 2: Generate the location sheet image
    const imageResult = await context.run('generate-sheet-image', async () => {
      logger.info('[LibraryLocationSheetWorkflow]', {
        data: `Generating 3x3 grid sheet for ${input.locationName} with model ${generationParams.model}`,
      });

      return await generateImageWithProvider(generationParams, { scopedDb });
    });

    // Deduct credits for image generation (skip if team used own fal key)
    await context.run('deduct-credits-sheet', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Library location sheet (${generationParams.model})`,
        metadata: {
          model: generationParams.model,
          locationName: input.locationName,
          locationDbId: input.locationDbId,
        },
        workflowName: 'LibraryLocationSheetWorkflow',
      });
    });

    // Step 3: Upload sheet to R2 storage
    const storageResult = await context.run('upload-to-storage', async () => {
      const imageUrl = imageResult.imageUrls[0];
      if (!imageUrl) {
        throw new Error('No image URL returned from generation');
      }

      logger.info('[LibraryLocationSheetWorkflow]', {
        data: `Uploading sheet to storage for ${input.locationName}`,
      });

      // Fetch and stream directly to R2
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch generated image: ${response.status}`);
      }

      // Build storage path: locations/{teamId}/{sequenceId}/{locationDbId}/sheet_{uniqueId}.png
      const uniqueId = generateId();
      const storagePath = `${input.teamId}/${input.sequenceId}/${input.locationDbId}/sheet_${uniqueId}.png`;

      const result = await uploadResponse(
        response,
        STORAGE_BUCKETS.LOCATIONS,
        storagePath,
        {
          contentType: 'image/png',
        }
      );

      return {
        url: result.publicUrl,
        path: result.path,
      };
    });

    // Step 4: Update database with the generated sheet
    await context.run('update-database', async () => {
      logger.info('[LibraryLocationSheetWorkflow]', {
        data: `Updating database for ${input.locationName}`,
      });

      await scopedDb.locations.updateReference(
        input.locationDbId,
        storageResult.url,
        storageResult.path
      );
    });

    // Step 5: Generate preview establishing shot for card thumbnail
    const hasReferenceImages = input.referenceImageUrls.length > 0;
    const previewResult = await context.run(
      'generate-preview-image',
      async () => {
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;
        const prompt = buildLocationPreviewPrompt(
          input.locationName,
          input.locationDescription,
          hasReferenceImages
        );

        logger.info('[LibraryLocationSheetWorkflow]', {
          data: `Generating preview establishing shot for ${input.locationName}`,
        });

        const previewParams: ImageGenerationParams = {
          model,
          prompt,
          imageSize: 'landscape_16_9',
          numImages: 1,
          traceName: 'location-preview-image',
        } satisfies ImageGenerationParams;

        if (hasReferenceImages) {
          previewParams.referenceImageUrls = input.referenceImageUrls;
        }

        return await generateImageWithProvider(previewParams, { scopedDb });
      }
    );

    // Deduct credits for preview generation
    await context.run('deduct-credits-preview', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(previewResult.metadata),
        usedOwnKey: previewResult.metadata.usedOwnKey,
        description: `Location preview (${input.imageModel ?? DEFAULT_IMAGE_MODEL})`,
        metadata: { locationDbId: input.locationDbId, type: 'preview' },
        workflowName: 'LibraryLocationSheetWorkflow',
      });
    });

    const previewUrl = previewResult.imageUrls[0];
    if (!previewUrl) {
      throw new Error('No preview URL returned from generation');
    }

    // Step 6: Upload preview to R2 storage
    const previewStorageResult = await context.run(
      'upload-preview-to-storage',
      async () => {
        logger.info('[LibraryLocationSheetWorkflow]', {
          data: `Uploading preview to storage for ${input.locationName}`,
        });

        const response = await fetch(previewUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated preview: ${response.status}`
          );
        }

        const previewPath = `${input.teamId}/${input.sequenceId}/${input.locationDbId}/preview.png`;

        const result = await uploadResponse(
          response,
          STORAGE_BUCKETS.LOCATIONS,
          previewPath,
          { contentType: 'image/png' }
        );

        return {
          url: result.publicUrl,
          path: result.path,
        };
      }
    );

    // Step 7: Update location with preview as the referenceImageUrl
    await context.run('update-location-preview', async () => {
      logger.info('[LibraryLocationSheetWorkflow]', {
        data: `Updating location with preview image`,
      });

      await scopedDb.locations.updateReference(
        input.locationDbId,
        previewStorageResult.url,
        previewStorageResult.path
      );
    });

    // Emit completed status
    await context.run('emit-completed', async () => {
      logger.info('[LibraryLocationSheetWorkflow]', {
        data: `Library location sheet workflow completed for ${input.locationName}`,
      });

      await getLocationChannel(input.locationDbId).emit(
        'location.sheet:progress',
        {
          locationId: input.locationDbId,
          status: 'completed',
          sheetImageUrl: storageResult.url,
        }
      );
    });

    const result: LibraryLocationSheetWorkflowResult = {
      sheetImageUrl: storageResult.url,
      sheetImagePath: storageResult.path,
      previewImageUrl: previewStorageResult.url,
      previewImagePath: previewStorageResult.path,
      locationDbId: input.locationDbId,
    };

    return result;
  },
  {
    failureFunction: async ({ context, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      logger.error('[LibraryLocationSheetWorkflow]', {
        data: `Sheet generation failed for location ${input.locationName}: ${error}`,
      });

      await getLocationChannel(input.locationDbId).emit(
        'location.sheet:progress',
        {
          locationId: input.locationDbId,
          status: 'failed',
          error: `Sheet generation failed: ${error}`,
        }
      );

      return `Library location sheet generation failed for ${input.locationName}`;
    },
  }
);
