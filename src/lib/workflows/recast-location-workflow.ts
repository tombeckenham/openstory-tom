/**
 * Recast Location Workflow
 *
 * Orchestrates the full location recast flow:
 * 1. Generate new location reference image with library reference
 * 2. Regenerate all frames at this location
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { getGenerationChannel } from '@/lib/realtime';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type { RecastLocationWorkflowInput } from '@/lib/workflow/types';
import { locationSheetWorkflow } from './location-sheet-workflow';
import {
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
} from './regenerate-frames-snapshot';
import { regenerateFramesWorkflow } from './regenerate-frames-workflow';
import {
  computeLocationSheetHashFromDto,
  resolveLibraryLocationReferenceHash,
} from './sheet-snapshots';
import type { LocationSheetWorkflowInput } from '@/lib/workflow/types';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'recast-location']);

export const recastLocationWorkflow =
  createScopedWorkflow<RecastLocationWorkflowInput>(
    async (context, scopedDb) => {
      const input = context.requestPayload;
      const label = buildWorkflowLabel(input.sequenceId);

      logger.info('[RecastLocationWorkflow]', {
        data: `Starting recast for ${input.locationName} with ${input.affectedFrameIds.length} affected frames`,
      });

      // Step 1: Generate new location reference image with library reference.
      // Inline the upstream library-location's reference_input_hash so the
      // child workflow can detect divergence if the library location is
      // regenerated mid-flight.
      const sheetBody = await context.run(
        'build-location-sheet-snapshot',
        async (): Promise<LocationSheetWorkflowInput> => {
          const libraryLocationReferenceHash =
            await resolveLibraryLocationReferenceHash(
              scopedDb,
              input.locationDbId
            );
          const partial: LocationSheetWorkflowInput = {
            locationDbId: input.locationDbId,
            locationName: input.locationName,
            locationMetadata: input.locationMetadata,
            sequenceId: input.sequenceId,
            teamId: input.teamId,
            userId: input.userId,
            imageModel: input.imageModel,
            referenceImageUrl: input.referenceImageUrl,
            libraryLocationDescription: input.libraryLocationDescription,
            styleConfig: input.styleConfig,
            libraryLocationReferenceHash,
          };
          partial.snapshotInputHash =
            await computeLocationSheetHashFromDto(partial);
          return partial;
        }
      );

      const { body: sheetResult, isFailed: sheetFailed } = await context.invoke(
        'location-sheet',
        {
          workflow: locationSheetWorkflow,
          label,
          body: sheetBody,
        }
      );

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (sheetFailed || !sheetResult?.referenceImageUrl) {
        throw new Error(
          `Location reference generation failed for ${input.locationName}`
        );
      }

      logger.info('[RecastLocationWorkflow]', {
        data: `Location reference generated for ${input.locationName}, regenerating ${input.affectedFrameIds.length} frames`,
      });

      // Step 2: Regenerate frames if there are any affected
      let framesRegenerated = 0;
      let framesFailed = 0;

      if (input.affectedFrameIds.length > 0) {
        const sequenceId = input.sequenceId;
        if (!sequenceId) {
          throw new Error(
            '[RecastLocationWorkflow] sequenceId is required to regenerate frames'
          );
        }
        const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
        const regenerateBody = await context.run(
          'build-regenerate-snapshot',
          async () => {
            const sequence = await scopedDb.sequences.getById(sequenceId);
            if (!sequence) {
              throw new Error(
                `[RecastLocationWorkflow] Sequence ${sequenceId} not found`
              );
            }
            const [characters, locations, frames] = await Promise.all([
              scopedDb.characters.listWithSheets(sequenceId),
              scopedDb.sequenceLocations.listWithReferences(sequenceId),
              scopedDb.frames.getByIds(input.affectedFrameIds),
            ]);
            // Reject silent drops: getByIds returns only existing rows, so a
            // missing frame would shrink frameSnapshots below frameIds without
            // any signal. Surface the gap so the caller can fix data drift
            // instead of zero-counting frames that never ran.
            if (frames.length !== input.affectedFrameIds.length) {
              const found = new Set(frames.map((f) => f.id));
              const missing = input.affectedFrameIds.filter(
                (id) => !found.has(id)
              );
              throw new Error(
                `[RecastLocationWorkflow] Missing frames for ${input.locationName}: ${missing.join(', ')}`
              );
            }
            const aspectRatio = sequence.aspectRatio;
            const frameSnapshots = await Promise.all(
              frames.map((frame) =>
                buildRegenerateFrameSnapshot({
                  frame,
                  characters,
                  locations,
                  imageModel,
                  aspectRatio,
                })
              )
            );
            const partial = {
              sequenceId,
              imageModel,
              aspectRatio,
              frameSnapshots,
            };
            const snapshotInputHash =
              await computeRegenerateFramesBatchHash(partial);
            return {
              userId: input.userId,
              teamId: input.teamId,
              sequenceId,
              frameIds: input.affectedFrameIds,
              triggerKind: 'location' as const,
              triggerId: input.locationDbId,
              imageModel,
              aspectRatio,
              frameSnapshots,
              snapshotInputHash,
            };
          }
        );

        const { body: regenerateResult, isFailed: regenerateFailed } =
          await context.invoke('regenerate-frames', {
            workflow: regenerateFramesWorkflow,
            label,
            body: regenerateBody,
          });

        if (regenerateFailed) {
          // The child workflow's failureFunction has already emitted
          // recast-location:failed. Throw so the parent's failureFunction
          // also fires rather than returning zeroed counts as success.
          throw new Error(
            `[RecastLocationWorkflow] Frame regeneration failed for ${input.locationName}; reference was generated but no frames were updated`
          );
        }
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        framesRegenerated = regenerateResult?.successCount ?? 0;
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        framesFailed = regenerateResult?.failedFrames?.length ?? 0;
        logger.info('[RecastLocationWorkflow]', {
          data: `Regenerated ${framesRegenerated} frames for ${input.locationName}`,
        });
      }

      return {
        referenceImageUrl: sheetResult.referenceImageUrl,
        framesRegenerated,
        framesFailed,
      };
    },
    {
      failureFunction: async ({ context, failResponse }) => {
        const input = context.requestPayload;
        const error = sanitizeFailResponse(failResponse);

        await getGenerationChannel(input.sequenceId).emit(
          'generation.recast-location:failed',
          {
            locationId: input.locationDbId,
            error,
          }
        );

        logger.error('[RecastLocationWorkflow]', {
          data: `Recast failed for ${input.locationName}: ${error}`,
        });

        return `Recast failed for ${input.locationName}`;
      },
    }
  );
