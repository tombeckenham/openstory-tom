/**
 * Regenerate Frames Workflow
 *
 * Bulk regenerates frame images after character/location recast. Operates
 * entirely from an inlined snapshot DTO assembled at trigger time — no live
 * mutable reads inside `context.run`.
 *
 * Convergent path (current inputs match snapshot): records `thumbnailInputHash`
 * on the frame and the matching `frame_variants` row alongside the primary
 * write that `image-workflow` already performed.
 * Divergent path (something changed mid-flight): leaves the primary frame
 * artifact alone and rewrites the per-model `frame_variants` row as a
 * divergence (input_hash + diverged_at) so the UI can offer it as an
 * alternative without disturbing the user's live thumbnail.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import { aspectRatioToImageSize } from '@/lib/constants/aspect-ratios';
import { getGenerationChannel } from '@/lib/realtime';
import { triggerWorkflow } from '@/lib/workflow/client';
import { WorkflowValidationError } from '@/lib/workflow/errors';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import { sanitizeFailResponse } from '@/lib/workflow/sanitize-fail-response';
import { createScopedWorkflow } from '@/lib/workflow/scoped-workflow';
import type {
  RegenerateFramesWorkflowInput,
  ShotVariantWorkflowInput,
} from '@/lib/workflow/types';
import { getFalFlowControl } from './constants';
import { generateImageWorkflow } from './image-workflow';
import {
  buildConvergentWrites,
  buildDivergentWrites,
  buildRegenerateFrameSnapshot,
  computeRegenerateFramesBatchHash,
  emitRecastEvent,
} from './regenerate-frames-snapshot';

type FrameResult =
  | { frameId: string; success: true; imageUrl: string }
  | { frameId: string; success: false; error: string };

type RegenerateFramesResult = {
  totalFrames: number;
  successCount: number;
  failedFrames: string[];
  divergedFrameIds: string[];
};

export const regenerateFramesWorkflow = createScopedWorkflow<
  RegenerateFramesWorkflowInput,
  RegenerateFramesResult
>(
  async (context, scopedDb) => {
    const input = context.requestPayload;
    const { sequenceId, teamId, triggerKind, triggerId } = input;
    const label = buildWorkflowLabel(sequenceId);

    if (!sequenceId) {
      throw new WorkflowValidationError('Sequence ID is required');
    }

    // Re-validate the snapshot hash inside the workflow body. The middleware
    // also checks at start, but Upstash routes middleware throws to
    // console.error without re-raising — this throw propagates via context.run
    // and triggers the failureFunction.
    await context.run('validate-snapshot', async () => {
      if (context.snapshot) {
        await context.snapshot.validate();
      }
    });

    const snapshots = input.frameSnapshots;
    if (snapshots.length === 0) {
      return {
        totalFrames: 0,
        successCount: 0,
        failedFrames: [],
        divergedFrameIds: [],
      };
    }

    const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
    const aspectRatio = input.aspectRatio;

    await context.run('emit-start', async () => {
      await emitRecastEvent({
        kind: triggerKind,
        event: 'start',
        sequenceId,
        triggerId,
        frameCount: snapshots.length,
      });
    });

    const imageResults: FrameResult[] = await Promise.all(
      snapshots.map(async (snapshot): Promise<FrameResult> => {
        if (!snapshot.imagePrompt) {
          // Per-frame failure — peer frames in the batch should still run.
          return {
            frameId: snapshot.frameId,
            success: false,
            error: 'no image prompt',
          };
        }

        const referenceImages = [
          ...snapshot.characterRefs,
          ...snapshot.locationRefs,
        ];

        const { body, isFailed, isCanceled } = await context.invoke('image', {
          workflow: generateImageWorkflow,
          label,
          body: {
            userId: input.userId,
            teamId,
            sequenceId,
            frameId: snapshot.frameId,
            prompt: snapshot.imagePrompt,
            model: imageModel,
            imageSize: aspectRatioToImageSize(aspectRatio),
            numImages: 1,
            referenceImages,
          },
          retries: 3,
          retryDelay: 'pow(2, retried) * 1000',
          flowControl: getFalFlowControl(),
        });

        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
        if (isFailed || isCanceled || !body?.imageUrl) {
          const reason = isCanceled
            ? 'canceled'
            : isFailed
              ? 'failed'
              : 'no imageUrl';
          console.error(
            '[RegenerateFramesWorkflow]',
            `Image generation failed frame=${snapshot.frameId} reason=${reason}`
          );
          return {
            frameId: snapshot.frameId,
            success: false,
            error: `Image generation ${reason}`,
          };
        }

        return {
          frameId: snapshot.frameId,
          success: true,
          imageUrl: body.imageUrl,
        };
      })
    );

    const divergedFrameIds: string[] = [];

    await context.run('reconcile-divergence', async () => {
      const allCharacters =
        await scopedDb.characters.listWithSheets(sequenceId);
      const allLocations =
        await scopedDb.sequenceLocations.listWithReferences(sequenceId);

      for (const result of imageResults) {
        if (!result.success) continue;

        const snapshot = snapshots.find((s) => s.frameId === result.frameId);
        if (!snapshot) {
          // Invariant: imageResults is built from snapshots, so this should
          // never fire. If it does, that's a corruption bug worth surfacing.
          throw new Error(
            `[RegenerateFramesWorkflow] Reconcile invariant: imageResults produced frameId=${result.frameId} not in snapshots`
          );
        }

        const liveFrame = await scopedDb.frames.getById(result.frameId);
        if (!liveFrame) {
          // Frame was deleted mid-flight. The speculative thumbnail was
          // already written by image-workflow, but its row is gone — there's
          // nothing left to reconcile. Log so the count drift is traceable.
          console.warn(
            '[RegenerateFramesWorkflow]',
            `Frame ${result.frameId} deleted mid-flight; skipping reconciliation`
          );
          continue;
        }

        const currentSnapshot = await buildRegenerateFrameSnapshot({
          frame: liveFrame,
          characters: allCharacters,
          locations: allLocations,
          imageModel,
          aspectRatio,
        });

        if (currentSnapshot.snapshotInputHash === snapshot.snapshotInputHash) {
          const writes = buildConvergentWrites(snapshot.snapshotInputHash);
          await scopedDb.frames.update(result.frameId, writes.frame);
          const updated = await scopedDb.frameVariants.updateByFrameAndModel(
            result.frameId,
            'image',
            imageModel,
            writes.variant
          );
          if (!updated) {
            throw new Error(
              `Convergent reconcile: no frame_variants row for frame=${result.frameId} model=${imageModel} — image-workflow's dual-write must run before regenerate-frames reconciles.`
            );
          }
          continue;
        }

        // Divergent path. Three writes in order:
        //   1. Revert the speculative primary thumbnail on the frame row.
        //   2. Revert the speculative URL on the primary variant row so the
        //      primary slot stops pointing at diverged work.
        //   3. Insert a divergent alternate row preserving the diverged
        //      result so the UI can offer it for comparison/promotion.
        // Steps 1 and 2 must precede 3: if step 3 fails, the user keeps
        // ownership of their live edits (no stale primary), at the cost of
        // losing the diverged result. The inverse would leave the UI saying
        // "diverged" while the speculative thumbnail still owned the primary.
        const divergedAt = new Date();
        const writes = buildDivergentWrites(
          snapshot.snapshotInputHash,
          divergedAt
        );

        await scopedDb.frames.update(result.frameId, writes.frame);

        const reverted = await scopedDb.frameVariants.updateByFrameAndModel(
          result.frameId,
          'image',
          imageModel,
          writes.primaryRevert
        );
        if (!reverted) {
          throw new Error(
            `Divergent reconcile: no primary frame_variants row to revert for frame=${result.frameId} model=${imageModel} — image-workflow's dual-write must run before regenerate-frames reconciles.`
          );
        }

        await scopedDb.frameVariants.insertDivergent({
          frameId: result.frameId,
          sequenceId,
          variantType: 'image',
          model: imageModel,
          url: result.imageUrl,
          ...writes.divergentRow,
        });
        divergedFrameIds.push(result.frameId);

        await getGenerationChannel(sequenceId).emit(
          'generation.image:progress',
          {
            frameId: result.frameId,
            status: 'pending',
            model: imageModel,
          }
        );

        console.log(
          '[RegenerateFramesWorkflow]',
          `Diverged frame ${result.frameId}: snapshot=${snapshot.snapshotInputHash.slice(0, 8)} current=${currentSnapshot.snapshotInputHash.slice(0, 8)}`
        );
      }
    });

    // Shot variants (the 3x3 grid in the Variants tab) are derived from the
    // primary thumbnail. Image-workflow regenerated the primary; without this
    // step the grid keeps showing the pre-recast character. Fire-and-forget:
    // each variant runs as its own workflow so this batch returns as soon as
    // primaries are reconciled. Only fan out for convergent frames — divergent
    // frames preserve the user's live primary, so their existing shot
    // variants are still correct.
    await context.run('trigger-variant-regen', async () => {
      const divergedFrameIdSet = new Set(divergedFrameIds);
      const convergent = imageResults.filter(
        (r): r is Extract<FrameResult, { success: true }> =>
          r.success && !divergedFrameIdSet.has(r.frameId)
      );

      await Promise.all(
        convergent.map(async (result) => {
          const snapshot = snapshots.find((s) => s.frameId === result.frameId);
          if (!snapshot) return;

          await triggerWorkflow<ShotVariantWorkflowInput>(
            '/variant-image',
            {
              userId: input.userId,
              teamId,
              sequenceId,
              frameId: result.frameId,
              thumbnailUrl: result.imageUrl,
              scenePrompt: snapshot.imagePrompt,
              characterReferences:
                snapshot.characterRefs.length > 0
                  ? snapshot.characterRefs
                  : undefined,
              locationReferences:
                snapshot.locationRefs.length > 0
                  ? snapshot.locationRefs
                  : undefined,
              aspectRatio,
              model: imageModel,
            },
            {
              label,
              // Dedupe: a retry of this context.run mustn't re-fire variants.
              deduplicationId: `variant-image-${result.frameId}-${imageModel}-${snapshot.snapshotInputHash.slice(0, 16)}`,
            }
          );
        })
      );
    });

    const failedFrames = imageResults
      .filter((r) => !r.success)
      .map((r) => r.frameId);
    const successCount = imageResults.length - failedFrames.length;

    await context.run('emit-complete', async () => {
      await emitRecastEvent({
        kind: triggerKind,
        event: 'complete',
        sequenceId,
        triggerId,
        successCount,
        failedCount: failedFrames.length,
      });
    });

    console.log(
      '[RegenerateFramesWorkflow]',
      `Completed: ${successCount} success, ${failedFrames.length} failed, ${divergedFrameIds.length} diverged`
    );

    return {
      totalFrames: snapshots.length,
      successCount,
      failedFrames,
      divergedFrameIds,
    };
  },
  {
    failureFunction: async ({ context, failResponse }) => {
      const input = context.requestPayload;
      const error = sanitizeFailResponse(failResponse);

      if (input.sequenceId) {
        await emitRecastEvent({
          kind: input.triggerKind,
          event: 'failed',
          sequenceId: input.sequenceId,
          triggerId: input.triggerId,
          error,
        });
      }

      console.error(
        '[RegenerateFramesWorkflow]',
        `Frame regeneration failed: ${error}`
      );

      return `Frame regeneration failed: ${error}`;
    },
    snapshot: {
      computeFromDto: (input) => computeRegenerateFramesBatchHash(input),
      computeCurrent: async (input, scopedDb) => {
        if (!input.sequenceId) {
          throw new WorkflowValidationError(
            'Sequence ID is required for snapshot computation'
          );
        }
        const characters = await scopedDb.characters.listWithSheets(
          input.sequenceId
        );
        const locations = await scopedDb.sequenceLocations.listWithReferences(
          input.sequenceId
        );
        const frames = await scopedDb.frames.getByIds(input.frameIds);
        const aspectRatio = input.aspectRatio;
        const imageModel = input.imageModel ?? DEFAULT_IMAGE_MODEL;
        const fresh = await Promise.all(
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
        return computeRegenerateFramesBatchHash({
          ...input,
          frameSnapshots: fresh,
        });
      },
    },
  }
);
