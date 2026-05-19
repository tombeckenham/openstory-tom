/**
 * Cloudflare Workflows port of `mergeAudioVideoWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/merge-audio-video-workflow.ts`)
 * step for step — same step names, same control flow, same side effects. The
 * only differences are:
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `cf/base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads the workflow run id from `event.instanceId` instead of
 *     `context.workflowRunId`.
 *   - The QStash `failureFunction` is implemented as the `onFailure`
 *     override on this class.
 *
 * The QStash version stays as-is — both run side by side until
 * `engine-registry.ts` flips `merge-audio-video` to `'cloudflare'`. See
 * docs/investigations/cloudflare-workflows-poc.md.
 */

import { composeAudioVideo } from '@/lib/audio/compose-audio-video';
import { normalizeAudioLoudness } from '@/lib/audio/loudness-normalize';
import { usdToMicros } from '@/lib/billing/money';
import { deductWorkflowCredits } from '@/lib/billing/workflow-deduction';
import { generateId } from '@/lib/db/id';
import type { ScopedDb } from '@/lib/db/scoped';
import { getGenerationChannel } from '@/lib/realtime';
import { STORAGE_BUCKETS } from '@/lib/storage/buckets';
import { uploadResponse } from '@/lib/storage/upload-response';
import {
  getExtensionFromUrl,
  getMimeTypeFromExtension,
} from '@/lib/utils/file';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/cf/base-workflow';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type { MergeAudioVideoWorkflowInput } from '@/lib/workflow/types';
import { resolveMergeAudioVideoSourceUrls } from '@/lib/workflows/merge-variant-resolution';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

type MergeAudioVideoWorkflowResult = {
  mergedVideoUrl: string;
  mergedVideoPath: string;
};

export class MergeAudioVideoWorkflow extends OpenStoryWorkflowEntrypoint<MergeAudioVideoWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<MergeAudioVideoWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<MergeAudioVideoWorkflowResult> {
    const input = event.payload;

    const { sequenceId, teamId, mergedVideoVariantId, musicVariantId } = input;
    if (!sequenceId || !teamId || !mergedVideoVariantId || !musicVariantId) {
      throw new WorkflowValidationError(
        'Sequence ID, mergedVideoVariantId, and musicVariantId are required'
      );
    }
    const seq = scopedDb.sequence(sequenceId);

    const sources = await step.do('resolve-variant-urls', async () =>
      resolveMergeAudioVideoSourceUrls(
        scopedDb,
        mergedVideoVariantId,
        musicVariantId
      )
    );
    const { mergedVideoUrl, musicUrl } = sources;

    await step.do('set-merging-status', async () => {
      console.log(
        `[MergeAudioVideoWorkflow:cf] Starting mux for sequence ${sequenceId}`
      );
      await seq.updateMergedVideoFields({
        mergedVideoStatus: 'merging',
        mergedVideoError: null,
      });

      await getGenerationChannel(sequenceId).emit('generation.merge:progress', {
        step: 'audio-video',
        status: 'merging',
      });
    });

    const videoDurationMs = await step.do(
      'compute-video-duration',
      async () => {
        const frames = await scopedDb.frames.listBySequence(sequenceId);
        return frames.reduce((sum, f) => sum + (f.durationMs ?? 3000), 0);
      }
    );

    const normalizedMusicUrl = await step.do(
      'normalize-music-loudness',
      async () => {
        const result = await normalizeAudioLoudness({
          audioUrl: musicUrl,
          scopedDb,
        });
        return result.audioUrl;
      }
    );

    const muxResult = await step.do('compose-audio-video', async () => {
      return composeAudioVideo({
        videoUrl: mergedVideoUrl,
        musicUrl: normalizedMusicUrl,
        durationMs: videoDurationMs,
        scopedDb,
      });
    });

    await step.do('deduct-credits', async () => {
      await deductWorkflowCredits({
        scopedDb,
        costMicros: usdToMicros(muxResult.cost),
        usedOwnKey: muxResult.usedOwnKey,
        description: 'Audio+video mux',
        metadata: { sequenceId },
        workflowName: 'MergeAudioVideoWorkflow',
      });
    });

    const storageResult = await step.do('upload-to-storage', async () => {
      const response = await fetch(muxResult.videoUrl);
      if (!response.ok) {
        throw new Error(
          `Failed to download muxed video: ${response.statusText}`
        );
      }

      const extension = getExtensionFromUrl(muxResult.videoUrl) || 'mp4';
      const contentType = getMimeTypeFromExtension(extension);
      const shortHash = generateId().slice(-8);
      const path = `teams/${teamId}/sequences/${sequenceId}/merged/${shortHash}_openstory.${extension}`;

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

    await step.do('update-sequence', async () => {
      await seq.updateMergedVideoFields({
        mergedVideoUrl: storageResult.url,
        mergedVideoPath: storageResult.path,
        mergedVideoStatus: 'completed',
        mergedVideoGeneratedAt: new Date(),
        mergedVideoError: null,
      });

      await getGenerationChannel(sequenceId).emit('generation.merge:progress', {
        step: 'audio-video',
        status: 'completed',
        mergedVideoUrl: storageResult.url,
      });
    });

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
    event: Readonly<WorkflowEvent<MergeAudioVideoWorkflowInput>>;
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
          { step: 'audio-video', status: 'failed' }
        );
      } catch (emitError) {
        console.error(
          `[MergeAudioVideoWorkflow:cf] Failed to emit failure event for sequence ${input.sequenceId}:`,
          emitError
        );
      }
    }
    console.error(
      `[MergeAudioVideoWorkflow:cf] Failed to mux sequence ${input.sequenceId}: ${error}`
    );
  }
}
