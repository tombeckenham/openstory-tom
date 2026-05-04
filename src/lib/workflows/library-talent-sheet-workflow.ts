/**
 * Library Talent Sheet Generation Workflow
 *
 * Generates talent reference sheets from user-uploaded reference media.
 * Uses the reference images to create a consistent talent sheet.
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
  buildLibraryTalentSheetPrompt,
  buildTalentHeadshotPrompt,
} from '@/lib/prompts/character-prompt';
import { getTalentChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { triggerWorkflow } from '@/lib/workflow/client';
import {
  SnapshotDivergedError,
  SnapshotRequeueDepthExceededError,
  isSnapshotDivergedFailure,
  WorkflowValidationError,
} from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  LibraryTalentSheetWorkflowInput,
  LibraryTalentSheetWorkflowResult,
} from '@/lib/workflow/types';
import {
  computeLibraryTalentSheetHashCurrent,
  computeLibraryTalentSheetHashFromDto,
  MAX_REQUEUE_DEPTH,
} from './sheet-snapshots';

export const libraryTalentSheetWorkflow = createScopedWorkflow<
  LibraryTalentSheetWorkflowInput,
  LibraryTalentSheetWorkflowResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;

    await context.run('validate-snapshot', async () => {
      if (context.snapshot) {
        await context.snapshot.validate();
      }
    });

    // Step 1: Validate input
    await context.run('validate-input', async () => {
      if (!input.talentId) {
        throw new WorkflowValidationError('talentId is required');
      }

      // Verify talent exists and belongs to team
      const talentRecord = await scopedDb.talent.getById(input.talentId);
      if (!talentRecord) {
        throw new WorkflowValidationError('Talent not found');
      }

      const hasReferenceImages =
        input.referenceImageUrls && input.referenceImageUrls.length > 0;
      const imageCount = input.referenceImageUrls?.length ?? 0;

      console.log(
        '[LibraryTalentSheetWorkflow]',
        `Starting sheet generation for talent ${input.talentName}${hasReferenceImages ? ` with ${imageCount} reference images` : ' (no reference images - generating from name/description)'}`
      );

      // Emit generating status
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      await getTalentChannel(input.talentId)?.emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'generating',
      });
    });

    // Step 2: Generate the talent sheet image with references
    const imageResult = await context.run('generate-sheet-image', async () => {
      const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;
      const hasReferenceImages =
        input.referenceImageUrls && input.referenceImageUrls.length > 0;
      const prompt = buildLibraryTalentSheetPrompt(
        input.talentName,
        input.talentDescription,
        hasReferenceImages
      );

      console.log(
        '[LibraryTalentSheetWorkflow]',
        `Generating sheet with model ${model}${hasReferenceImages ? ' (with reference images)' : ' (text-to-image only)'}`
      );

      const generationParams: ImageGenerationParams = {
        model,
        prompt,
        imageSize: 'landscape_16_9',
        numImages: 1,
        resolution: '2K',
        traceName: 'talent-sheet-image',
      } satisfies ImageGenerationParams;

      // Only include referenceImageUrls if provided
      if (hasReferenceImages) {
        generationParams.referenceImageUrls = input.referenceImageUrls;
      }

      return await generateImageWithProvider(generationParams, { scopedDb });
    });

    // Deduct credits for sheet generation (skip if team used own fal key)
    await context.run('deduct-credits-sheet', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(imageResult.metadata),
        usedOwnKey: imageResult.metadata.usedOwnKey,
        description: `Talent sheet (${input.imageModel ?? DEFAULT_IMAGE_MODEL})`,
        metadata: { talentId: input.talentId, type: 'sheet' },
        workflowName: 'LibraryTalentSheetWorkflow',
      });
    });

    const imageUrl = imageResult.imageUrls[0];
    if (!imageUrl) {
      throw new Error('No image URL returned from generation');
    }

    // Step 3: Upload to R2 storage
    const storageResult = await context.run('upload-to-storage', async () => {
      console.log('[LibraryTalentSheetWorkflow]', `Uploading sheet to storage`);

      // Fetch and stream directly to R2
      const response = await fetch(imageUrl);
      if (!response.ok) {
        throw new Error(`Failed to fetch generated image: ${response.status}`);
      }

      // Build storage path
      const sheetId = generateId();
      const storagePath = `${input.teamId}/${input.talentId}/${sheetId}.png`;

      const result = await uploadResponse(
        response,
        STORAGE_BUCKETS.TALENT,
        storagePath,
        { contentType: 'image/png' }
      );

      return {
        sheetId,
        url: result.publicUrl,
        path: result.path,
      };
    });

    // Step 4: Divergence-aware sheet record creation. If reference media
    // changed mid-flight, discard and re-queue with the current set.
    const snapshot = context.snapshot;
    const sheetReconcile = await context.run(
      'reconcile-create-sheet',
      async (): Promise<
        | {
            kind: 'convergent';
            sheet: Awaited<ReturnType<typeof scopedDb.talent.sheets.create>>;
          }
        | { kind: 'divergent' }
      > => {
        if (snapshot) {
          const currentHash = await snapshot.computeCurrent();
          if (currentHash !== snapshot.snapshotInputHash) {
            console.warn('[LibraryTalentSheetWorkflow] divergence detected', {
              talentId: input.talentId,
              snapshotInputHash: snapshot.snapshotInputHash,
              currentHash,
              orphanedStoragePath: storageResult.path,
            });
            return { kind: 'divergent' };
          }
        }
        console.log(
          '[LibraryTalentSheetWorkflow]',
          `Creating sheet record in database`
        );
        const created = await scopedDb.talent.sheets.create({
          id: storageResult.sheetId,
          talentId: input.talentId,
          name: input.sheetName ?? 'Generated Sheet',
          imageUrl: storageResult.url,
          imagePath: storageResult.path,
          isDefault: false,
          source: 'ai_generated',
          inputHash: snapshot?.snapshotInputHash ?? null,
        });
        return { kind: 'convergent', sheet: created };
      }
    );

    if (sheetReconcile.kind === 'divergent' && snapshot) {
      const requeueDepth = (input.requeueDepth ?? 0) + 1;
      const requeueOutcome = await context.run(
        'requeue-on-divergence',
        async (): Promise<'requeued' | 'depth-exceeded'> => {
          console.log(
            '[LibraryTalentSheetWorkflow]',
            `Diverged for ${input.talentName}; re-queuing with current reference media (depth=${requeueDepth})`
          );

          if (requeueDepth > MAX_REQUEUE_DEPTH) {
            console.warn(
              '[LibraryTalentSheetWorkflow] re-queue depth exceeded',
              {
                talentId: input.talentId,
                talentName: input.talentName,
                requeueDepth,
                max: MAX_REQUEUE_DEPTH,
              }
            );
            return 'depth-exceeded';
          }

          const talent = await scopedDb.talent.getWithRelations(input.talentId);
          // Hard-fail when the talent row vanished: re-queuing with the stale
          // payload would guarantee another divergence and another billable
          // generation. Let the next run's validate-input step error out cleanly.
          if (!talent) {
            throw new WorkflowValidationError(
              `Talent ${input.talentId} not found during divergence re-queue`
            );
          }
          const refreshedUrls = talent.media
            .filter((m) => m.type === 'image')
            .map((m) => m.url)
            .sort();
          const requeuePayload: LibraryTalentSheetWorkflowInput = {
            ...input,
            referenceImageUrls: refreshedUrls,
            requeueDepth,
          };
          requeuePayload.snapshotInputHash =
            await computeLibraryTalentSheetHashFromDto(requeuePayload);
          await triggerWorkflow('/library-talent-sheet', requeuePayload, {
            deduplicationId: `library-talent-sheet-requeue-${input.talentId}-${requeuePayload.snapshotInputHash.slice(0, 16)}-d${requeueDepth}`,
          });
          return 'requeued';
        }
      );

      if (requeueOutcome === 'depth-exceeded') {
        throw new SnapshotRequeueDepthExceededError(
          `library-talent-sheet hit MAX_REQUEUE_DEPTH for ${input.talentName}; marking failed`
        );
      }
      throw new SnapshotDivergedError(
        `library-talent-sheet diverged for ${input.talentName}; re-queued with current reference media`
      );
    }

    if (sheetReconcile.kind === 'divergent') {
      // Snapshot was disabled but reconcile still flagged divergence — should
      // be unreachable; surface as a workflow validation error so it doesn't
      // silently swallow.
      throw new WorkflowValidationError(
        'reconcile flagged divergent without an active snapshot context'
      );
    }

    const sheet = sheetReconcile.sheet;

    // Emit sheet_ready so the UI can show the sheet and switch to "Generating portrait…"
    await context.run('emit-sheet-ready', async () => {
      await getTalentChannel(input.talentId)?.emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'sheet_ready',
        sheetId: sheet.id,
        sheetImageUrl: storageResult.url,
      });
    });

    // Step 5: Generate talent headshot for avatar
    const headshotResult = await context.run(
      'generate-headshot-image',
      async () => {
        const model = input.imageModel ?? DEFAULT_IMAGE_MODEL;
        const hasReferenceImages =
          input.referenceImageUrls && input.referenceImageUrls.length > 0;
        const prompt = buildTalentHeadshotPrompt(
          input.talentName,
          input.talentDescription,
          hasReferenceImages
        );

        console.log(
          '[LibraryTalentSheetWorkflow]',
          `Generating headshot with model ${model}${hasReferenceImages ? ' (with reference images)' : ' (text-to-image only)'}`
        );

        const generationParams: ImageGenerationParams = {
          model,
          prompt,
          imageSize: 'square_hd',
          numImages: 1,
          traceName: 'talent-headshot-image',
        } satisfies ImageGenerationParams;

        // Only include referenceImageUrls if provided
        if (hasReferenceImages) {
          generationParams.referenceImageUrls = input.referenceImageUrls;
        }

        return await generateImageWithProvider(generationParams, { scopedDb });
      }
    );

    // Deduct credits for headshot generation (skip if team used own fal key)
    await context.run('deduct-credits-headshot', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: extractImageCost(headshotResult.metadata),
        usedOwnKey: headshotResult.metadata.usedOwnKey,
        description: `Talent headshot (${input.imageModel ?? DEFAULT_IMAGE_MODEL})`,
        metadata: { talentId: input.talentId, type: 'headshot' },
        workflowName: 'LibraryTalentSheetWorkflow',
      });
    });

    const headshotUrl = headshotResult.imageUrls[0];
    if (!headshotUrl) {
      throw new Error('No headshot URL returned from generation');
    }

    // Step 6: Upload headshot to R2 storage
    const headshotStorageResult = await context.run(
      'upload-headshot-to-storage',
      async () => {
        console.log(
          '[LibraryTalentSheetWorkflow]',
          `Uploading headshot to storage`
        );

        // Fetch and stream directly to R2
        const response = await fetch(headshotUrl);
        if (!response.ok) {
          throw new Error(
            `Failed to fetch generated headshot: ${response.status}`
          );
        }

        // Build storage path for headshot
        const headshotPath = `${input.teamId}/${input.talentId}/headshot.png`;

        const result = await uploadResponse(
          response,
          STORAGE_BUCKETS.TALENT,
          headshotPath,
          { contentType: 'image/png' }
        );

        return {
          url: result.publicUrl,
          path: result.path,
        };
      }
    );

    // Step 7: Update talent with headshot
    await context.run('update-talent-headshot', async () => {
      console.log(
        '[LibraryTalentSheetWorkflow]',
        `Updating talent with headshot`
      );

      await scopedDb.talent.update(input.talentId, {
        imageUrl: headshotStorageResult.url,
        imagePath: headshotStorageResult.path,
      });
    });

    // Emit completed status
    await context.run('emit-completed', async () => {
      console.log(
        '[LibraryTalentSheetWorkflow]',
        `Talent sheet workflow completed for ${input.talentName}`
      );

      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      await getTalentChannel(input.talentId)?.emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'completed',
        sheetId: sheet.id,
        sheetImageUrl: storageResult.url,
        headshotImageUrl: headshotStorageResult.url,
      });
    });

    return {
      sheetId: sheet.id,
      sheetImageUrl: storageResult.url,
      sheetImagePath: storageResult.path,
      headshotImageUrl: headshotStorageResult.url,
      headshotImagePath: headshotStorageResult.path,
    };
  },
  {
    failureFunction: async ({ context, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      if (isSnapshotDivergedFailure(failResponse)) {
        console.log(
          '[LibraryTalentSheetWorkflow]',
          `Run aborted due to snapshot divergence for ${input.talentName}; re-queued run will continue`
        );
        return `Library talent sheet diverged for ${input.talentName}; re-queued`;
      }

      console.error(
        '[LibraryTalentSheetWorkflow]',
        `Sheet generation failed for talent ${input.talentName}: ${error}`
      );

      // Emit failed status
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      await getTalentChannel(input.talentId)?.emit('talent.sheet:progress', {
        talentId: input.talentId,
        status: 'failed',
        error: `Sheet generation failed: ${error}`,
      });

      return `Talent sheet generation failed for ${input.talentName}`;
    },
    snapshot: {
      computeFromDto: (input) => computeLibraryTalentSheetHashFromDto(input),
      computeCurrent: (input, scopedDb) =>
        computeLibraryTalentSheetHashCurrent(input, scopedDb),
    },
  }
);
