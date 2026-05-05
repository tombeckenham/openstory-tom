/**
 * Location Sheet Generation Workflow
 *
 * Generates location reference images (establishing shots) for visual consistency.
 * These images are later used as reference images when generating scene images.
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
import { buildLocationSheetPrompt } from '@/lib/prompts/location-prompt';
import { getGenerationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult,
} from '@/lib/workflow/types';
import {
  computeLocationSheetHashCurrent,
  computeLocationSheetHashFromDto,
} from './sheet-snapshots';
import {
  decideSheetDivergence,
  saveDivergentLocationSheet,
} from './sheet-divergence';

export const locationSheetWorkflow = createScopedWorkflow<
  LocationSheetWorkflowInput,
  LocationSheetWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    await context.run('validate-snapshot', async () => {
      if (context.snapshot) {
        await context.snapshot.validate();
      }
    });

    // Emit realtime event that generation has started
    await context.run('emit-start-event', async () => {
      if (input.sequenceId && input.locationDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.location-sheet:progress',
          {
            locationId: input.locationDbId,
            status: 'generating',
          }
        );
      }
    });

    // Step 1: Validate and build prompt
    const generationParams: ImageGenerationParams = await context.run(
      'build-prompt',
      async () => {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (!input.locationMetadata) {
          throw new WorkflowValidationError('locationMetadata is required');
        }

        const hasLibraryLocation = !!(
          input.referenceImageUrl || input.libraryLocationDescription
        );
        console.log(
          '[LocationSheetWorkflow]',
          `Starting reference generation for location ${input.locationName}${hasLibraryLocation ? ' with library location reference' : ''}`
        );

        // Build library location overrides if data is provided
        const libraryOverrides = hasLibraryLocation
          ? {
              description: input.libraryLocationDescription,
              referenceImageUrl: input.referenceImageUrl,
            }
          : undefined;

        // Build prompt with location identity + library reference + sequence style
        const { prompt, referenceUrls } = buildLocationSheetPrompt(
          input.locationMetadata,
          libraryOverrides,
          input.styleConfig
        );
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;

        return {
          model,
          prompt,
          // Location reference images use landscape aspect ratio for establishing shots
          imageSize: 'landscape_16_9' as const,
          numImages: 1,
          // Use library reference image(s) for visual consistency
          referenceImageUrls:
            referenceUrls.length > 0 ? referenceUrls : undefined,
          traceName: 'location-sheet-image',
        } satisfies ImageGenerationParams;
      }
    );

    // Step 2: Generate the location reference image
    const imageResult = await context.run(
      'generate-reference-image',
      async () => {
        console.log(
          '[LocationSheetWorkflow]',
          `Generating reference for ${input.locationName} with model ${generationParams.model}`
        );

        return await generateImageWithProvider(generationParams, { scopedDb });
      }
    );

    // Deduct credits for image generation (skip if team used own fal key)
    await context.run('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Location sheet (${generationParams.model})`,
        metadata: {
          model: generationParams.model,
          locationName: input.locationName,
          locationDbId: input.locationDbId,
        },
        workflowName: 'LocationSheetWorkflow',
      });
    });

    let referenceImageUrl = imageResult.imageUrls[0];
    let referenceImagePath: string | undefined = undefined;

    if (input.locationDbId && input.teamId && input.sequenceId) {
      // Capture narrowed values so inner async closures see `string`, not
      // `string | undefined`.
      const locationDbId = input.locationDbId;
      const sequenceId = input.sequenceId;

      // Step 3: Upload to R2 storage
      const storageResult = await context.run('upload-to-storage', async () => {
        const imageUrl = imageResult.imageUrls[0];
        if (!imageUrl) {
          throw new Error('No image URL returned from generation');
        }

        console.log(
          '[LocationSheetWorkflow]',
          `Uploading reference to storage for ${input.locationName}`
        );

        // Fetch and stream directly to R2
        const response = await fetch(imageUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated image: ${response.status}`
          );
        }

        // Build storage path: locations/{teamId}/{sequenceId}/{locationDbId}/{uniqueId}.png
        const uniqueId = generateId();
        const storagePath = `${input.teamId}/${input.sequenceId}/${input.locationDbId}/${uniqueId}.png`;

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

      // Step 4: Divergence-aware database write. On convergent, update the
      // sequence location's primary reference. On divergent, preserve the
      // artifact as a variant row (the helper emits `stale:detected`) and
      // skip the primary update so the in-flight run does not overwrite a
      // now-stale reference.
      const snapshot = context.snapshot;
      const reconcileOutcome = await context.run(
        'reconcile-database',
        async (): Promise<{ kind: 'convergent' } | { kind: 'divergent' }> => {
          console.log(
            '[LocationSheetWorkflow]',
            `Updating database for ${input.locationName}`
          );

          const decision = decideSheetDivergence(
            snapshot?.snapshotInputHash,
            snapshot ? await snapshot.computeCurrent() : null
          );

          if (decision.kind === 'divergent') {
            console.warn('[LocationSheetWorkflow] divergence detected', {
              locationDbId,
              snapshotInputHash: decision.snapshotInputHash,
              currentInputHash: decision.currentInputHash,
              storagePath: storageResult.path,
            });
            await saveDivergentLocationSheet({
              scopedDb,
              parent: {
                type: 'sequence_location',
                id: locationDbId,
                sequenceId,
              },
              model: generationParams.model,
              url: storageResult.url,
              storagePath: storageResult.path,
              workflowRunId: context.workflowRunId,
              snapshotInputHash: decision.snapshotInputHash,
            });
            return { kind: 'divergent' };
          }

          await scopedDb.sequenceLocations.updateReference(
            locationDbId,
            storageResult.url,
            storageResult.path,
            snapshot?.snapshotInputHash ?? null
          );
          return { kind: 'convergent' };
        }
      );

      referenceImagePath = storageResult.path;
      referenceImageUrl = storageResult.url;

      if (reconcileOutcome.kind === 'divergent') {
        // Helper already emitted `stale:detected` on the sequence channel.
        // Settle the primary reference status so the UI does not stay wedged
        // on "Regenerating…". The pre-existing `referenceImageUrl` (if any)
        // remains the live primary — we deliberately did not overwrite it.
        // For first-time generation the entity ends in `completed` with a
        // null referenceImageUrl; the user can manually retry. Either way,
        // flipping status to `completed` reflects "generation finished,
        // primary unchanged, divergent variant saved alongside".
        await context.run('settle-divergent-status', async () => {
          await scopedDb.sequenceLocations.updateReferenceStatus(
            locationDbId,
            'completed'
          );
          await getGenerationChannel(sequenceId).emit(
            'generation.location-sheet:progress',
            {
              locationId: locationDbId,
              status: 'completed',
            }
          );
        });
        console.log(
          '[LocationSheetWorkflow]',
          `Diverged for ${input.locationName}; saved as variant`
        );
        return {
          referenceImageUrl,
          referenceImagePath,
          locationDbId,
        };
      }
    }

    // Emit realtime event that generation is complete
    await context.run('emit-complete-event', async () => {
      if (input.sequenceId && input.locationDbId) {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.location-sheet:progress',
          {
            locationId: input.locationDbId,
            status: 'completed',
            referenceImageUrl,
          }
        );
      }
    });

    console.log(
      '[LocationSheetWorkflow]',
      `Location reference workflow completed for ${input.locationName}`
    );

    const result: LocationSheetWorkflowResult = {
      referenceImageUrl,
      referenceImagePath,
      locationDbId: input.locationDbId,
    };

    return result;
  },
  {
    failureFunction: async ({ context, scopedDb, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      // Mark location reference as failed
      if (input.locationDbId && input.teamId) {
        await scopedDb.sequenceLocations.updateReferenceStatus(
          input.locationDbId,
          'failed',
          error
        );

        // Emit failure event for realtime UI update
        if (input.sequenceId) {
          await getGenerationChannel(input.sequenceId).emit(
            'generation.location-sheet:progress',
            {
              locationId: input.locationDbId,
              status: 'failed',
              error,
            }
          );
        }

        console.error(
          '[LocationSheetWorkflow]',
          `Reference generation failed for location ${input.locationName}: ${error}`
        );
      }

      return `Location reference generation failed for ${input.locationName}`;
    },
    snapshot: {
      computeFromDto: (input) => computeLocationSheetHashFromDto(input),
      computeCurrent: (input, scopedDb) =>
        computeLocationSheetHashCurrent(input, scopedDb),
    },
  }
);
