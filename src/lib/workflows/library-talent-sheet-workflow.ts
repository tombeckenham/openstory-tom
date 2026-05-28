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
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'workflow', 'library-talent-sheet']);

import type {
  LibraryTalentSheetWorkflowInput,
  LibraryTalentSheetWorkflowResult,
} from '@/lib/workflow/types';
import {
  computeLibraryTalentSheetHashCurrent,
  computeLibraryTalentSheetHashFromDto,
} from './sheet-snapshots';
import {
  decideSheetDivergence,
  saveDivergentTalentSheet,
} from './sheet-divergence';

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

      logger.info('[LibraryTalentSheetWorkflow]', {
        data: `Starting sheet generation for talent ${input.talentName}${hasReferenceImages ? ` with ${imageCount} reference images` : ' (no reference images - generating from name/description)'}`,
      });

      // Emit generating status
      await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
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

      logger.info('[LibraryTalentSheetWorkflow]', {
        data: `Generating sheet with model ${model}${hasReferenceImages ? ' (with reference images)' : ' (text-to-image only)'}`,
      });

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
      logger.info('[LibraryTalentSheetWorkflow]', {
        data: `Uploading sheet to storage`,
      });

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

    // Step 4: Divergence-aware sheet record creation. Always create the
    // talent_sheets row; on divergence, attach a variant to it (preserving
    // the artifact as a parented sheet against the snapshot identity that
    // triggered this run) and stop before the headshot + talent.update steps
    // so this now-stale run cannot overwrite the talent's primary identity.
    const snapshot = context.snapshot;
    const sheetReconcile = await context.run(
      'reconcile-create-sheet',
      async (): Promise<{
        kind: 'convergent' | 'divergent';
        sheet: Awaited<ReturnType<typeof scopedDb.talent.sheets.create>>;
      }> => {
        logger.info('[LibraryTalentSheetWorkflow]', {
          data: `Creating sheet record in database`,
        });
        // Compute divergence first so we can mark the talent_sheets row at
        // creation time. A divergent sheet must NOT be eligible to back-fill
        // the talent's primary identity in any UI fallback chain (e.g.
        // `sheets.find(default) ?? sheets[0]`); the `divergedAt` column is
        // the marker the read-side filters on.
        const decision = decideSheetDivergence(
          snapshot?.snapshotInputHash,
          snapshot ? await snapshot.computeCurrent() : null
        );

        // QStash retries this step verbatim if any later call inside it (e.g.
        // saveDivergentTalentSheet's realtime emit) throws transiently.
        // talent.sheets.create is keyed on a stable PK we passed from the
        // upload step, so a retry would raise SQLITE_CONSTRAINT_PRIMARYKEY
        // without this pre-check — short-circuit on the existing row.
        const existing = await scopedDb.talent.sheets.getById(
          storageResult.sheetId
        );
        const created =
          existing ??
          (await scopedDb.talent.sheets.create({
            id: storageResult.sheetId,
            talentId: input.talentId,
            name: input.sheetName ?? 'Generated Sheet',
            imageUrl: storageResult.url,
            imagePath: storageResult.path,
            isDefault: false,
            source: 'ai_generated',
            inputHash: snapshot?.snapshotInputHash ?? null,
            divergedAt: decision.kind === 'divergent' ? new Date() : null,
          }));

        if (decision.kind === 'divergent') {
          logger.warn('divergence detected', {
            talentId: input.talentId,
            snapshotInputHash: decision.snapshotInputHash,
            currentInputHash: decision.currentInputHash,
            storagePath: storageResult.path,
          });
          await saveDivergentTalentSheet({
            scopedDb,
            talentSheetId: created.id,
            talentId: input.talentId,
            model: input.imageModel ?? DEFAULT_IMAGE_MODEL,
            url: storageResult.url,
            storagePath: storageResult.path,
            workflowRunId: context.workflowRunId,
            snapshotInputHash: decision.snapshotInputHash,
          });
          return { kind: 'divergent', sheet: created };
        }

        return { kind: 'convergent', sheet: created };
      }
    );

    const sheet = sheetReconcile.sheet;

    if (sheetReconcile.kind === 'divergent') {
      // Helper already emitted `stale:detected` on the talent channel.
      // Stop here: do not generate the headshot or update talent.imageUrl,
      // so a now-stale run cannot overwrite the talent's primary identity.
      // The talent_sheets row was created with `isDefault: false` (and
      // `talent.sheets.create` honors the explicit false even when the talent
      // has no other sheets), so it shows up in the talent's sheet list
      // without becoming the talent's primary image. Emit a terminal
      // `talent.sheet:progress` so the UI clears its "Generating sheet…"
      // spinner — without this the hook would stay stuck because it only
      // releases on `completed` or `failed`.
      await context.run('emit-divergent-settled', async () => {
        // Omit `sheetImageUrl` from the divergent-completed event so any
        // future subscriber that reads the payload directly (instead of
        // refetching via the hook's query invalidation) cannot mistake the
        // divergent variant URL for the talent's live primary image.
        // `talentId` is guarded non-null at the workflow's `validate-input`
        // step, so `getTalentChannel` always returns a real channel here.
        await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
          talentId: input.talentId,
          status: 'completed',
          sheetId: sheet.id,
        });
      });
      logger.info('[LibraryTalentSheetWorkflow]', {
        data: `Diverged for ${input.talentName}; saved as variant`,
      });
      return {
        sheetId: sheet.id,
        sheetImageUrl: storageResult.url,
        sheetImagePath: storageResult.path,
      };
    }

    // Emit sheet_ready so the UI can show the sheet and switch to "Generating portrait…"
    await context.run('emit-sheet-ready', async () => {
      await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
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

        logger.info('[LibraryTalentSheetWorkflow]', {
          data: `Generating headshot with model ${model}${hasReferenceImages ? ' (with reference images)' : ' (text-to-image only)'}`,
        });

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
        logger.info('[LibraryTalentSheetWorkflow]', {
          data: `Uploading headshot to storage`,
        });

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
      logger.info('[LibraryTalentSheetWorkflow]', {
        data: `Updating talent with headshot`,
      });

      await scopedDb.talent.update(input.talentId, {
        imageUrl: headshotStorageResult.url,
        imagePath: headshotStorageResult.path,
      });
    });

    // Emit completed status
    await context.run('emit-completed', async () => {
      logger.info('[LibraryTalentSheetWorkflow]', {
        data: `Talent sheet workflow completed for ${input.talentName}`,
      });

      await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
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

      logger.error('[LibraryTalentSheetWorkflow]', {
        data: `Sheet generation failed for talent ${input.talentName}: ${error}`,
      });

      // Emit failed status
      await getTalentChannel(input.talentId).emit('talent.sheet:progress', {
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
