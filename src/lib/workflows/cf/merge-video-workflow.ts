/**
 * Cloudflare Workflows port of `mergeVideoWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/merge-video-workflow.ts`)
 * step for step — same step names, same control flow, same side effects.
 * The only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `cf/base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - Calls the snapshot DTO computers directly instead of going through
 *     the `context.snapshot.*` extension.
 *   - The chained `merge-audio-video` child invocation uses Pattern 3
 *     (`spawnAndAwaitChild`) inside `chainAudioMux`.
 *
 * The QStash version stays as-is — both run side by side until
 * `engine-registry.ts` flips `merge-video` to `'cloudflare'`. See
 * docs/investigations/cloudflare-workflows-poc.md.
 */

import { usdToMicros } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import type { ScopedDb } from '@/lib/db/scoped';
import { generateId } from '@/lib/db/id';
import { mergeVideos } from '@/lib/motion/merge-videos';
import { getGenerationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { spawnAndAwaitChild } from '@/lib/workflow/cf/await-child';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/cf/base-workflow';
import type { CloudflareEnv } from '@/lib/workflow/cf/types';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  MergeAudioVideoWorkflowInput,
  MergeAudioVideoWorkflowResult,
  MergeVideoWorkflowInput,
  MergeVideoWorkflowResult,
} from '@/lib/workflow/types';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import { resolveMusicVariantForMux } from '@/lib/workflows/merge-variant-resolution';
import {
  computeSequenceVideoHashCurrent,
  computeSequenceVideoHashFromDto,
} from '@/lib/workflows/sequence-snapshots';

export const MERGE_VIDEO_WORKFLOW_NAME = 'merge-video';

/**
 * Chain to merge-audio-video if the sequence has a ready music track.
 * This keeps the UI "Merge with Video" CTA honest — it restitches frames
 * and also muxes the existing music onto the fresh output.
 *
 * Both the merged video and the music are sourced as variants — `merge-audio-video`
 * accepts variant ids so the final output is a function of `(video, music)`.
 *
 * NOTE: child invocation is stubbed pending Pattern 3 batch (see file docblock).
 */
async function chainAudioMux(
  step: WorkflowStep,
  env: CloudflareEnv,
  parentInstanceId: string,
  scopedDb: ScopedDb,
  input: MergeVideoWorkflowInput & { sequenceId: string },
  mergedVideoVariantId: string
): Promise<void> {
  if (input.skipAudioMux) {
    console.log(
      `[MergeVideoWorkflow:cf] skipAudioMux=true; bypassing audio mux for sequence ${input.sequenceId}`
    );
    return;
  }

  const musicVariantId = await step.do(
    'fetch-music-variant-for-mux',
    async () => resolveMusicVariantForMux(scopedDb, input.sequenceId)
  );

  if (!musicVariantId) {
    return;
  }

  const binding = env.MERGE_AUDIO_VIDEO_WORKFLOW;
  if (!binding) {
    throw new NonRetryableError(
      'MERGE_AUDIO_VIDEO_WORKFLOW binding is missing on env — check wrangler.jsonc',
      'WorkflowValidationError'
    );
  }

  await spawnAndAwaitChild<
    MergeAudioVideoWorkflowInput,
    MergeAudioVideoWorkflowResult
  >(step, {
    binding,
    parentBindingName: 'MERGE_VIDEO_WORKFLOW',
    parentInstanceId,
    childId: `merge-audio-video:${input.sequenceId}:${mergedVideoVariantId}:${musicVariantId}`,
    childPayload: {
      userId: input.userId,
      teamId: input.teamId,
      sequenceId: input.sequenceId,
      mergedVideoVariantId,
      musicVariantId,
    },
    spawnStepName: 'spawn-merge-audio-video',
    awaitStepName: 'await-merge-audio-video',
  });
}

export class MergeVideoWorkflow extends OpenStoryWorkflowEntrypoint<MergeVideoWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MergeVideoWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<MergeVideoWorkflowResult> {
    const input = event.payload;

    if (!input.sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }
    // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
    if (!input.videoUrls || input.videoUrls.length === 0) {
      throw new WorkflowValidationError('At least one video URL is required');
    }

    const narrowedInput = { ...input, sequenceId: input.sequenceId };
    const seq = scopedDb.sequence(input.sequenceId);

    const inputHash = await step.do('compute-input-hash', async () => {
      console.log(
        `[MergeVideoWorkflow:cf] Starting merge for sequence ${input.sequenceId} with ${input.videoUrls.length} videos`
      );
      return computeSequenceVideoHashFromDto(input);
    });

    // Single video: skip merge, use existing video directly
    if (input.videoUrls.length === 1) {
      const singleUrl = input.videoUrls[0];
      if (!singleUrl) {
        throw new WorkflowValidationError('Video URL is required');
      }

      const currentHash = await step.do(
        'compute-current-hash-single',
        async () => computeSequenceVideoHashCurrent(input, scopedDb)
      );

      const writeResult = await step.do(
        'write-video-variant-single',
        async () => {
          return scopedDb.sequenceVariants.writeVideoVariant({
            sequenceId: narrowedInput.sequenceId,
            url: singleUrl,
            storagePath: null,
            workflow: MERGE_VIDEO_WORKFLOW_NAME,
            status: 'completed',
            generatedAt: new Date(),
            error: null,
            inputHash,
            currentHash,
          });
        }
      );

      if (writeResult.divergent) {
        // Divergent single-video result: prior primary on `sequences.merged*`
        // stays authoritative. We never set merging-status on the
        // single-video path, but emit a terminal event so any in-flight UI
        // spinner stops, plus a `stale:detected` for the divergent banner.
        const divergedVariantId = writeResult.variant.id;
        await step.do('emit-divergent-single', async () => {
          const channel = getGenerationChannel(narrowedInput.sequenceId);
          await channel.emit('generation.merge:progress', {
            step: 'video',
            status: 'completed',
          });
          await channel.emit('generation.stale:detected', {
            entityType: 'sequence',
            entityId: narrowedInput.sequenceId,
            artifact: 'merged-video',
            snapshotInputHash: inputHash,
            divergedVariantId,
          });
        });
        console.log(
          `[MergeVideoWorkflow:cf] Diverged single-video result for sequence ${narrowedInput.sequenceId}; preserved as alternate (variant=${divergedVariantId})`
        );
        return { mergedVideoUrl: singleUrl, mergedVideoPath: null };
      }

      await step.do('update-sequence-single', async () => {
        await seq.updateMergedVideoFields({
          mergedVideoUrl: singleUrl,
          mergedVideoPath: null,
          mergedVideoStatus: 'completed',
          mergedVideoGeneratedAt: new Date(),
          mergedVideoError: null,
        });

        await getGenerationChannel(input.sequenceId).emit(
          'generation.merge:progress',
          { step: 'video', status: 'completed', mergedVideoUrl: singleUrl }
        );
      });

      await chainAudioMux(
        step,
        this.env,
        event.instanceId,
        scopedDb,
        narrowedInput,
        writeResult.variant.id
      );
      return { mergedVideoUrl: singleUrl, mergedVideoPath: null };
    }

    await step.do('set-merging-status', async () => {
      await seq.updateMergedVideoFields({
        mergedVideoStatus: 'merging',
        mergedVideoError: null,
      });

      await getGenerationChannel(input.sequenceId).emit(
        'generation.merge:progress',
        { step: 'video', status: 'merging' }
      );
    });

    const mergeResult = await step.do('merge-videos', async () => {
      return mergeVideos({
        videoUrls: input.videoUrls,
        scopedDb,
      });
    });

    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: usdToMicros(mergeResult.cost),
        usedOwnKey: mergeResult.metadata.usedOwnKey,
        description: `Video merge (${input.videoUrls.length} clips)`,
        metadata: { sequenceId: input.sequenceId },
        workflowName: 'MergeVideoWorkflow',
      });
    });

    const storageResult = await step.do('upload-to-storage', async () => {
      const response = await fetch(mergeResult.videoUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to download merged video: ${response.statusText}`
        );
      }

      const extension = getExtensionFromUrl(mergeResult.videoUrl) || 'mp4';
      const contentType = getMimeTypeFromExtension(extension);
      const shortHash = generateId().slice(-8);
      const path = `teams/${input.teamId}/sequences/${input.sequenceId}/merged/${shortHash}_openstory.${extension}`;

      const result = await uploadResponse(
        response,
        STORAGE_BUCKETS.VIDEOS,
        path,
        {
          contentType,
        }
      );

      return { path, url: result.publicUrl };
    });

    const currentHash = await step.do('compute-current-hash', async () =>
      computeSequenceVideoHashCurrent(input, scopedDb)
    );

    const writeResult = await step.do('write-video-variant', async () => {
      return scopedDb.sequenceVariants.writeVideoVariant({
        sequenceId: narrowedInput.sequenceId,
        url: storageResult.url,
        storagePath: storageResult.path,
        workflow: MERGE_VIDEO_WORKFLOW_NAME,
        status: 'completed',
        generatedAt: new Date(),
        error: null,
        inputHash,
        currentHash,
      });
    });

    if (writeResult.divergent) {
      // Divergent merge: prior primary on `sequences.merged*` stays
      // authoritative. `set-merging-status` set mergedVideoStatus='merging'
      // earlier, so reset to 'completed' here and emit a terminal event so
      // the UI doesn't hang at 'merging'. The alternate is preserved in
      // `sequence_video_variants` for future surfacing.
      const divergedVariantId = writeResult.variant.id;
      await step.do('update-sequence-divergent', async () => {
        await seq.updateMergedVideoFields({
          mergedVideoStatus: 'completed',
          mergedVideoError: null,
        });

        const channel = getGenerationChannel(narrowedInput.sequenceId);
        await channel.emit('generation.merge:progress', {
          step: 'video',
          status: 'completed',
        });
        await channel.emit('generation.stale:detected', {
          entityType: 'sequence',
          entityId: narrowedInput.sequenceId,
          artifact: 'merged-video',
          snapshotInputHash: inputHash,
          divergedVariantId,
        });
      });
      console.log(
        `[MergeVideoWorkflow:cf] Diverged merge result for sequence ${narrowedInput.sequenceId}; preserved as alternate (variant=${divergedVariantId})`
      );
      return {
        mergedVideoUrl: storageResult.url,
        mergedVideoPath: storageResult.path,
      };
    }

    await step.do('update-sequence', async () => {
      await seq.updateMergedVideoFields({
        mergedVideoUrl: storageResult.url,
        mergedVideoPath: storageResult.path,
        mergedVideoStatus: 'completed',
        mergedVideoGeneratedAt: new Date(),
        mergedVideoError: null,
      });

      await getGenerationChannel(input.sequenceId).emit(
        'generation.merge:progress',
        {
          step: 'video',
          status: 'completed',
          mergedVideoUrl: storageResult.url,
        }
      );
    });

    await chainAudioMux(
      step,
      this.env,
      event.instanceId,
      scopedDb,
      narrowedInput,
      writeResult.variant.id
    );

    return {
      mergedVideoUrl: storageResult.url,
      mergedVideoPath: storageResult.path,
    };
  }

  protected override async onFailure({
    event,
    error,
    scopedDb,
  }: {
    event: Readonly<WorkflowEvent<MergeVideoWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;
    if (input.sequenceId) {
      const failSeq = scopedDb.sequence(input.sequenceId);

      await failSeq.updateMergedVideoFields({
        mergedVideoStatus: 'failed',
        mergedVideoError: error,
      });

      try {
        await getGenerationChannel(input.sequenceId).emit(
          'generation.merge:progress',
          { step: 'video', status: 'failed' }
        );
      } catch (emitError) {
        console.error(
          `[MergeVideoWorkflow:cf] Failed to emit failure event for sequence ${input.sequenceId}:`,
          emitError
        );
      }
    }
    console.error(
      `[MergeVideoWorkflow:cf] Failed to merge sequence ${input.sequenceId}: ${error}`
    );
  }
}
