/**
 * Cloudflare Workflows port of `motionBatchWorkflow`.
 *
 * Mirrors the QStash version (`src/lib/workflows/motion-batch-workflow.ts`)
 * step for step — same control flow, same side effects. Differences (all
 * infrastructure-level, not behavioural):
 *
 *   - Extends `OpenStoryWorkflowEntrypoint` instead of being built by
 *     `createScopedWorkflow`. Failure parity comes from the base class
 *     (see `cf/base-workflow.ts`).
 *   - Uses `step.do` instead of `context.run`.
 *   - Reads payload from `event.payload` and the run id from
 *     `event.instanceId` instead of `context.requestPayload` /
 *     `context.workflowRunId`.
 *   - Each `context.invoke(...)` becomes a Pattern 3 `spawnAndAwaitChild`
 *     against the relevant binding (MOTION_WORKFLOW × N frames, optional
 *     MUSIC_WORKFLOW, MERGE_VIDEO_WORKFLOW, optional MERGE_AUDIO_VIDEO_WORKFLOW).
 *   - Fan-out: `Promise.all` on spawn (parents block until every child has
 *     been queued so a transient spawn failure surfaces as a workflow error
 *     rather than a silently-skipped child), `Promise.allSettled` on await
 *     so a single bad frame doesn't kill the rest of the batch.
 *
 * The QStash version stays as-is — both run side by side until
 * `engine-registry.ts` flips `motion-batch` to `'cloudflare'`. See
 * docs/investigations/cloudflare-workflows-poc.md.
 */

import type { ScopedDb } from '@/lib/db/scoped';
import { getGenerationChannel } from '@/lib/realtime';
import { OpenStoryWorkflowEntrypoint } from '@/lib/workflow/cf/base-workflow';
import { spawnAndAwaitChild } from '@/lib/workflow/cf/await-child';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import type {
  BatchMotionMusicWorkflowInput,
  MergeAudioVideoWorkflowInput,
  MergeAudioVideoWorkflowResult,
  MergeVideoWorkflowInput,
  MergeVideoWorkflowResult,
  MotionWorkflowInput,
  MotionWorkflowResult,
  MusicWorkflowInput,
  MusicWorkflowResult,
} from '@/lib/workflow/types';
import { resolveMotionBatchMergeMusicVariants } from '@/lib/workflows/merge-variant-resolution';
import { MERGE_VIDEO_WORKFLOW_NAME } from '@/lib/workflows/cf/merge-video-workflow';
import { buildMergeVideoSourcesFromFrames } from '@/lib/workflows/sequence-snapshots';
import type { WorkflowEvent, WorkflowStep } from 'cloudflare:workers';

type MotionBatchWorkflowResult = {
  sequenceId: string;
};

export class MotionBatchWorkflow extends OpenStoryWorkflowEntrypoint<BatchMotionMusicWorkflowInput> {
  protected override async runImpl(
    event: Readonly<WorkflowEvent<BatchMotionMusicWorkflowInput>>,
    step: WorkflowStep,
    scopedDb: ScopedDb
  ): Promise<MotionBatchWorkflowResult> {
    const input = event.payload;
    const parentInstanceId = event.instanceId;
    const { sequenceId, includeMusic } = input;

    if (!sequenceId) {
      throw new WorkflowValidationError('sequenceId is required');
    }
    if (!input.frames.length) {
      throw new WorkflowValidationError('At least one frame is required');
    }
    if (includeMusic && !input.music) {
      throw new WorkflowValidationError(
        'music config is required when includeMusic is true'
      );
    }

    // Resolve required child bindings up front. Missing bindings are a
    // deployment misconfiguration — fail fast with a non-retryable throw so
    // the dispatcher routes future runs through QStash instead of churning.
    const motionBinding = this.env.MOTION_WORKFLOW;
    if (!motionBinding) {
      throw new WorkflowValidationError(
        '[MotionBatchWorkflow:cf] MOTION_WORKFLOW binding missing on env — check wrangler.jsonc and run `bun cf:typegen`'
      );
    }
    const mergeVideoBinding = this.env.MERGE_VIDEO_WORKFLOW;
    if (!mergeVideoBinding) {
      throw new WorkflowValidationError(
        '[MotionBatchWorkflow:cf] MERGE_VIDEO_WORKFLOW binding missing on env — check wrangler.jsonc and run `bun cf:typegen`'
      );
    }
    const musicBinding = this.env.MUSIC_WORKFLOW;
    if (includeMusic && !musicBinding) {
      throw new WorkflowValidationError(
        '[MotionBatchWorkflow:cf] MUSIC_WORKFLOW binding missing on env (includeMusic=true) — check wrangler.jsonc and run `bun cf:typegen`'
      );
    }
    const mergeAudioVideoBinding = this.env.MERGE_AUDIO_VIDEO_WORKFLOW;
    if (includeMusic && !mergeAudioVideoBinding) {
      throw new WorkflowValidationError(
        '[MotionBatchWorkflow:cf] MERGE_AUDIO_VIDEO_WORKFLOW binding missing on env (includeMusic=true) — check wrangler.jsonc and run `bun cf:typegen`'
      );
    }

    // Step 1: Fan out motion workflows (one per frame) + optional music
    // workflow in parallel. Pattern 3 spawns + awaits each child via
    // `spawnAndAwaitChild`; Promise.allSettled lets a single failing frame
    // not poison the rest of the batch.
    const motionAwaits = input.frames.map((frame, index) => {
      const motionBody: MotionWorkflowInput = {
        userId: input.userId,
        teamId: input.teamId,
        frameId: frame.frameId,
        sequenceId,
        imageUrl: frame.imageUrl,
        prompt: frame.prompt,
        model: frame.model,
        duration: frame.duration,
        fps: frame.fps,
        motionBucket: frame.motionBucket,
        aspectRatio: frame.aspectRatio,
        generateAudio: frame.generateAudio,
        userEditedPrompt: frame.userEditedPrompt,
        // motion-batch invokes merge itself at step 3
        triggerMergeOnComplete: false,
      };

      return spawnAndAwaitChild<MotionWorkflowInput, MotionWorkflowResult>(
        step,
        {
          binding: motionBinding,
          parentBindingName: 'MOTION_BATCH_WORKFLOW',
          parentInstanceId,
          childId: `motion:${sequenceId}:${frame.frameId}`,
          childPayload: motionBody,
          spawnStepName: `spawn-motion-${index}`,
          awaitStepName: `await-motion-${index}`,
          timeout: '30 minutes',
        }
      );
    });

    const musicAwait =
      includeMusic && input.music && musicBinding
        ? spawnAndAwaitChild<MusicWorkflowInput, MusicWorkflowResult>(step, {
            binding: musicBinding,
            parentBindingName: 'MOTION_BATCH_WORKFLOW',
            parentInstanceId,
            childId: `music:${sequenceId}`,
            childPayload: {
              userId: input.userId,
              teamId: input.teamId,
              sequenceId,
              prompt: input.music.prompt,
              tags: input.music.tags,
              duration: input.music.duration,
              model: input.music.model,
            },
            spawnStepName: 'spawn-music',
            awaitStepName: 'await-music',
            timeout: '30 minutes',
          })
        : null;

    const motionResults = await Promise.allSettled(motionAwaits);
    const musicResult = musicAwait
      ? await Promise.allSettled([musicAwait])
      : null;

    // Log per-frame motion failures for visibility; we don't throw here — the
    // QStash original uses Promise.all + a single combined await, but parity
    // with the rest of the CF batch surface (frame-images) is to allSettle
    // and rely on the collect step below to validate that we have something
    // mergeable.
    for (let i = 0; i < motionResults.length; i++) {
      const r = motionResults[i];
      if (r?.status === 'rejected') {
        const frame = input.frames[i];
        console.warn(
          '[MotionBatchWorkflow:cf]',
          `Motion failed for frame ${frame?.frameId ?? '(unknown)'}:`,
          r.reason
        );
      }
    }
    if (musicResult) {
      const [m] = musicResult;
      if (m.status === 'rejected') {
        console.warn(
          '[MotionBatchWorkflow:cf]',
          `Music generation failed for sequence ${sequenceId}:`,
          m.reason
        );
      }
    }

    // Step 2: Collect video URLs and inline each frame's videoInputHash for
    // the merge-video snapshot pattern. Frames without a videoUrl are skipped.
    const { videoUrls, sourceFrameVideoHashes } = await step.do(
      'collect-video-urls',
      async () => {
        const frames = await scopedDb.frames.listBySequence(sequenceId);
        const sorted = [...frames].sort((a, b) => a.orderIndex - b.orderIndex);
        return buildMergeVideoSourcesFromFrames(sorted);
      }
    );

    if (videoUrls.length === 0) {
      // Throw INSIDE a step.do would retry — top-level validation throw
      // routes through the base class's WorkflowValidationError unwrap.
      throw new WorkflowValidationError(
        'No completed frame videos found after motion generation'
      );
    }

    // Step 3: Merge all frame videos into one. Spawn + await via Pattern 3.
    const mergeVideoBody: MergeVideoWorkflowInput = {
      userId: input.userId,
      teamId: input.teamId,
      sequenceId,
      videoUrls,
      sourceFrameVideoHashes,
    };

    await spawnAndAwaitChild<MergeVideoWorkflowInput, MergeVideoWorkflowResult>(
      step,
      {
        binding: mergeVideoBinding,
        parentBindingName: 'MOTION_BATCH_WORKFLOW',
        parentInstanceId,
        childId: `merge-video:${sequenceId}:${parentInstanceId}`,
        childPayload: mergeVideoBody,
        spawnStepName: 'spawn-merge-video',
        awaitStepName: 'await-merge-video',
        timeout: '30 minutes',
      }
    );

    // Step 4: If music was generated, mux audio onto merged video.
    // Resolve both source variants — final mux is a function of (video, music).
    if (includeMusic && mergeAudioVideoBinding) {
      const mergeAndMusicSources = await step.do(
        'get-merge-music-variants',
        async () =>
          resolveMotionBatchMergeMusicVariants(
            scopedDb,
            sequenceId,
            MERGE_VIDEO_WORKFLOW_NAME
          )
      );

      const muxBody: MergeAudioVideoWorkflowInput = {
        userId: input.userId,
        teamId: input.teamId,
        sequenceId,
        mergedVideoVariantId: mergeAndMusicSources.mergedVideoVariantId,
        musicVariantId: mergeAndMusicSources.musicVariantId,
      };

      await spawnAndAwaitChild<
        MergeAudioVideoWorkflowInput,
        MergeAudioVideoWorkflowResult
      >(step, {
        binding: mergeAudioVideoBinding,
        parentBindingName: 'MOTION_BATCH_WORKFLOW',
        parentInstanceId,
        childId: `merge-audio-video:${sequenceId}:${parentInstanceId}`,
        childPayload: muxBody,
        spawnStepName: 'spawn-merge-audio-video',
        awaitStepName: 'await-merge-audio-video',
        timeout: '30 minutes',
      });
    }

    return { sequenceId };
  }

  protected override async onFailure({
    event,
    error,
  }: {
    event: Readonly<WorkflowEvent<BatchMotionMusicWorkflowInput>>;
    error: string;
    scopedDb: ScopedDb;
  }): Promise<void> {
    const input = event.payload;

    if (input.sequenceId) {
      try {
        await getGenerationChannel(input.sequenceId).emit('generation.failed', {
          message: error,
        });
      } catch (emitError) {
        console.error(
          `[MotionBatchWorkflow:cf] Failed to emit generation.failed for sequence ${input.sequenceId}:`,
          emitError
        );
      }
    }

    console.error(
      `[MotionBatchWorkflow:cf] Failed for sequence ${input.sequenceId}: ${error}`
    );
  }
}
