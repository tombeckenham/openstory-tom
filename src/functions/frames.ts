import { DEFAULT_IMAGE_MODEL, safeTextToImageModel } from '@/lib/ai/models';
import {
  computeMotionPromptInputHash,
  computeVisualPromptInputHash,
} from '@/lib/ai/input-hash';
import { loadFramePromptContext } from '@/lib/ai/prompt-context';
import type { FrameVariant, NewFrame } from '@/lib/db/schema';
import { getGenerationChannel } from '@/lib/realtime';
import { getVideoDownloadUrl } from '@/lib/motion/video-storage';
import {
  bulkFrameSchema,
  singleFrameSchema,
  updateFrameSchema,
} from '@/lib/schemas/frame.schemas';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { reconcileStaleFrameStatuses } from '@/lib/workflow/reconcile';
import { buildRegenerateFrameSnapshot } from '@/lib/workflows/regenerate-frames-snapshot';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { frameAccessMiddleware, sequenceAccessMiddleware } from './middleware';

const frameIdInputSchema = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
});

export const getFramesFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    const frames = await context.scopedDb.frames.listBySequence(
      context.sequence.id
    );

    // Fire-and-forget: reconcile stale statuses in background
    reconcileStaleFrameStatuses(frames, context.scopedDb.frames).catch(
      console.error
    );

    return frames;
  });

export const getFrameFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .handler(async ({ context }) => {
    return context.frame;
  });

export const getSequenceImageModelsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.frameVariants.listModelsForSequence(
      context.sequence.id,
      'image'
    );
  });

export const getDivergentVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.frameVariants.listDivergentBySequence(
      context.sequence.id
    );
  });

type PromoteProgressEvent =
  | 'image:progress'
  | 'video:progress'
  | 'audio:progress';
type PromoteProgressUrlField = 'thumbnailUrl' | 'videoUrl' | 'audioUrl';

/**
 * Build the per-variantType `frames` update payload and matching realtime
 * progress event metadata for a promote-variant operation. Exported (and
 * pure) for unit testing — the server-fn handler wraps this in auth +
 * persistence.
 */
export function buildPromoteUpdate(variant: FrameVariant): {
  update: Partial<NewFrame>;
  progressEvent: PromoteProgressEvent;
  progressUrlField: PromoteProgressUrlField;
} {
  const update: Partial<NewFrame> = {};
  let progressEvent: PromoteProgressEvent;
  let progressUrlField: PromoteProgressUrlField;

  switch (variant.variantType) {
    case 'image':
      update.thumbnailUrl = variant.url;
      update.thumbnailPath = variant.storagePath;
      update.thumbnailStatus = 'completed';
      update.thumbnailError = null;
      update.thumbnailInputHash = variant.inputHash;
      update.imageModel = variant.model;
      // Downstream video is now misaligned with the new image — mark stale
      // by clearing it; the user will regenerate.
      update.videoUrl = null;
      update.videoPath = null;
      update.videoStatus = 'pending';
      update.videoWorkflowRunId = null;
      update.videoGeneratedAt = null;
      update.videoError = null;
      progressEvent = 'image:progress';
      progressUrlField = 'thumbnailUrl';
      break;
    case 'video':
      update.videoUrl = variant.url;
      update.videoPath = variant.storagePath;
      update.videoStatus = 'completed';
      update.videoError = null;
      update.videoInputHash = variant.inputHash;
      progressEvent = 'video:progress';
      progressUrlField = 'videoUrl';
      break;
    case 'audio':
      update.audioUrl = variant.url;
      update.audioPath = variant.storagePath;
      update.audioStatus = 'completed';
      update.audioError = null;
      update.audioInputHash = variant.inputHash;
      progressEvent = 'audio:progress';
      progressUrlField = 'audioUrl';
      break;
  }

  return { update, progressEvent, progressUrlField };
}

/**
 * Promote a divergent alternate to be the live primary for its variant type.
 * Copies the variant's url/path into the matching frames column, updates the
 * matching `*_input_hash` so the live row reflects the alternate's inputs,
 * soft-deletes the variant, and emits a synthetic `*:progress` event so any
 * listeners refresh.
 */
export const promoteVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frameId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const { frame, scopedDb } = context;
    const variant = await scopedDb.frameVariants.getById(data.variantId);
    if (!variant || variant.frameId !== frame.id) {
      throw new Error('Variant not found for this frame');
    }
    if (variant.divergedAt === null || variant.discardedAt !== null) {
      throw new Error('Variant is not a live divergent alternate');
    }
    if (!variant.url) {
      throw new Error('Variant has no asset to promote');
    }

    const { update, progressEvent, progressUrlField } =
      buildPromoteUpdate(variant);

    // Atomic: a partial failure can't leave the live primary updated with the
    // variant still appearing in the divergent list (or vice versa).
    const { frame: updatedFrame } =
      await scopedDb.frameVariants.promoteAtomically(
        frame.id,
        update,
        variant.id
      );

    // Realtime emit is purely cache-busting — TanStack Query refetches on the
    // mutation onSuccess invalidation regardless. A failed emit must not
    // surface to the user as "promote failed" when the DB already committed.
    const channel = getGenerationChannel(data.sequenceId);
    try {
      const url = updatedFrame[progressUrlField] ?? variant.url;
      await channel.emit(
        `generation.${progressEvent}`,
        progressEvent === 'audio:progress'
          ? {
              frameId: frame.id,
              status: 'completed',
              audioUrl: url ?? undefined,
            }
          : progressEvent === 'video:progress'
            ? {
                frameId: frame.id,
                status: 'completed',
                videoUrl: url ?? undefined,
              }
            : {
                frameId: frame.id,
                status: 'completed',
                thumbnailUrl: url ?? undefined,
                model: variant.model,
              }
      );
      // Promoting an image clears the downstream video — emit a paired
      // video:progress event so listeners deriving motion-banner state from
      // realtime (not just cache) reset immediately.
      if (variant.variantType === 'image') {
        await channel.emit('generation.video:progress', {
          frameId: frame.id,
          status: 'pending',
          videoUrl: undefined,
        });
      }
    } catch (error) {
      console.error('[promoteVariantFn] realtime emit failed', error);
    }

    return { frame: updatedFrame, variantId: variant.id };
  });

export const discardVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frameId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.frameVariants.getById(
      data.variantId
    );
    if (!variant || variant.frameId !== context.frame.id) {
      throw new Error('Variant not found for this frame');
    }
    const discardedAt = await context.scopedDb.frameVariants.discard(
      variant.id
    );
    return { variantId: variant.id, discardedAt };
  });

export const undiscardVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frameId: ulidSchema,
        variantId: ulidSchema,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const variant = await context.scopedDb.frameVariants.getById(
      data.variantId
    );
    if (!variant || variant.frameId !== context.frame.id) {
      throw new Error('Variant not found for this frame');
    }
    await context.scopedDb.frameVariants.undiscard(variant.id);
    return { variantId: variant.id };
  });

export const getSequenceImageVariantsFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    return context.scopedDb.frameVariants.listBySequence(
      context.sequence.id,
      'image'
    );
  });

export const createFrameFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(singleFrameSchema.extend({ sequenceId: ulidSchema }))
  )
  .handler(async ({ data, context }) => {
    return context.scopedDb.frames.create(data);
  });

export const createFramesBulkFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frames: bulkFrameSchema.shape.frames,
      })
    )
  )
  .handler(async ({ data, context }) => {
    const frameInserts: NewFrame[] = data.frames.map((frame) => ({
      sequenceId: data.sequenceId,
      ...frame,
    }));
    return context.scopedDb.frames.bulkUpsert(frameInserts);
  });

export const updateFrameFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(
    zodValidator(
      updateFrameSchema.extend({ sequenceId: ulidSchema, frameId: ulidSchema })
    )
  )
  .handler(async ({ data, context }) => {
    const { sequenceId: _, frameId, ...updateData } = data;
    return context.scopedDb.frames.update(frameId, updateData);
  });

export const deleteFrameFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameIdInputSchema))
  .handler(async ({ data, context }) => {
    await context.scopedDb.frames.delete(data.frameId);
    return { success: true, sequenceId: data.sequenceId };
  });

export const deleteFramesBySequenceFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .handler(async ({ context }) => {
    await context.scopedDb.frames.deleteBySequence(context.sequence.id);
    return { success: true };
  });

export const reorderFramesFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(
    zodValidator(
      z.object({
        sequenceId: ulidSchema,
        frameOrders: z
          .array(z.object({ id: ulidSchema, orderIndex: z.number().int() }))
          .min(1),
      })
    )
  )
  .handler(async ({ data, context }) => {
    const frameOrders = data.frameOrders.map((f) => ({
      id: f.id,
      order_index: f.orderIndex,
    }));
    await context.scopedDb.frames.reorder(data.sequenceId, frameOrders);
    return { success: true };
  });

/**
 * Returns staleness state for a frame's artifacts. Covers the rendered
 * thumbnail plus the visual / motion prompts (stage 4). Each value is
 * computed by re-deriving the current input hash from live scoped state and
 * comparing it to the stored `*_input_hash` via the scoped helper.
 *
 * Three states per artifact:
 *   - `'stale'`     — stored hash diverges from the freshly computed one.
 *   - `'fresh'`     — stored hash matches.
 *   - `'untracked'` — no stored hash (legacy artifact, or never generated).
 *                     Distinct from `'fresh'` so the UI can suppress the
 *                     regenerate prompt without lying about the artifact's
 *                     freshness.
 */
export const getFrameStalenessFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameIdInputSchema))
  .handler(async ({ context }) => {
    const { frame, sequence, scopedDb } = context;

    let thumbnail: 'stale' | 'fresh' | 'untracked' = 'untracked';
    if (frame.imagePrompt) {
      const [characters, locations] = await Promise.all([
        scopedDb.characters.listWithSheets(sequence.id),
        scopedDb.sequenceLocations.listWithReferences(sequence.id),
      ]);

      const snapshot = await buildRegenerateFrameSnapshot({
        frame,
        characters,
        locations,
        imageModel: safeTextToImageModel(frame.imageModel, DEFAULT_IMAGE_MODEL),
        aspectRatio: sequence.aspectRatio,
      });

      // `isStale` returns false for both "fresh" and "no stored hash" — the
      // imagePrompt-present check above narrows it to "fresh" when isStale
      // returns false.
      thumbnail = (await scopedDb.frames.isStale(
        frame.id,
        'thumbnail',
        snapshot.snapshotInputHash
      ))
        ? 'stale'
        : 'fresh';
    }

    let visualPrompt: 'stale' | 'fresh' | 'untracked' = 'untracked';
    let motionPrompt: 'stale' | 'fresh' | 'untracked' = 'untracked';

    if (frame.metadata && frame.visualPromptInputHash) {
      try {
        const latest = await scopedDb.framePromptVariants.getLatest(
          frame.id,
          'visual'
        );
        const ctx = await loadFramePromptContext({
          scopedDb,
          sequence,
          scene: frame.metadata,
          analysisModelOverride: latest?.analysisModel ?? null,
        });
        const liveHash = await computeVisualPromptInputHash(ctx);
        visualPrompt =
          liveHash !== frame.visualPromptInputHash ? 'stale' : 'fresh';
      } catch (error) {
        // Context unavailable (e.g., style deleted mid-flight). Stay
        // 'untracked' — fail-open as 'fresh' would silently lie to the user.
        console.warn(
          `[getFrameStalenessFn] visual staleness uncomputable for frame ${frame.id}:`,
          error
        );
      }
    }

    if (frame.metadata && frame.motionPromptInputHash) {
      try {
        const latest = await scopedDb.framePromptVariants.getLatest(
          frame.id,
          'motion'
        );
        const ctx = await loadFramePromptContext({
          scopedDb,
          sequence,
          scene: frame.metadata,
          analysisModelOverride: latest?.analysisModel ?? null,
        });
        const liveHash = await computeMotionPromptInputHash(ctx);
        motionPrompt =
          liveHash !== frame.motionPromptInputHash ? 'stale' : 'fresh';
      } catch (error) {
        console.warn(
          `[getFrameStalenessFn] motion staleness uncomputable for frame ${frame.id}:`,
          error
        );
      }
    }

    return { thumbnail, visualPrompt, motionPrompt };
  });

/**
 * Get a signed download URL for a frame's video.
 * Uses Content-Disposition: attachment to force browser download.
 */
export const getFrameDownloadUrlFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameIdInputSchema))
  .handler(async ({ context }) => {
    const { frame } = context;

    if (!frame.videoPath) {
      throw new Error('Frame does not have a video');
    }

    const filename =
      frame.videoPath.split('/').pop() || `scene-${frame.id}_openstory.mp4`;

    const downloadUrl = await getVideoDownloadUrl(
      frame.videoPath,
      filename,
      3600
    );

    return { downloadUrl, filename };
  });
