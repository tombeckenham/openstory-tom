/**
 * Stage 4 prompt history / restore / regenerate / staleness server fns.
 *
 * Reads `frame_prompt_variants` and `sequence_music_prompt_variants` for the
 * History UI, writes append-only `'user-edit'` rows for restore, triggers
 * the prompt-scene / music-prompt workflows for regenerate, and exposes a
 * music-prompt staleness check (visual / motion staleness lives on
 * `getFrameStalenessFn`).
 */

import { computeMusicPromptInputHash } from '@/lib/ai/input-hash';
import {
  DEFAULT_ANALYSIS_MODEL,
  getAnalysisModelById,
} from '@/lib/ai/models.config';
import { loadFramePromptContext } from '@/lib/ai/prompt-context';
import {
  FRAME_PROMPT_TYPES,
  type FramePromptVariant,
  type SequenceMusicPromptVariant,
} from '@/lib/db/schema';
import { ulidSchema } from '@/lib/schemas/id.schemas';
import { simpleHash } from '@/lib/utils/hash';
import { triggerWorkflow } from '@/lib/workflow/client';
import { buildWorkflowLabel } from '@/lib/workflow/labels';
import type {
  MotionPromptSceneWorkflowInput,
  MusicPromptWorkflowInput,
  VisualPromptSceneWorkflowInput,
} from '@/lib/workflow/types';
import { buildMusicSceneSummaries } from '@/lib/workflows/music-scene-summaries';
import { createServerFn } from '@tanstack/react-start';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { frameAccessMiddleware, sequenceAccessMiddleware } from './middleware';

const promptTypeSchema = z.enum(FRAME_PROMPT_TYPES);

export type FramePromptVariantWithAuthor = FramePromptVariant & {
  createdByName: string | null;
};

export type SequenceMusicPromptVariantWithAuthor =
  SequenceMusicPromptVariant & { createdByName: string | null };

const frameListInput = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
  promptType: promptTypeSchema,
});

export const listFramePromptVariantsFn = createServerFn({ method: 'GET' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameListInput))
  .handler(
    async ({ context, data }): Promise<FramePromptVariantWithAuthor[]> => {
      return await context.scopedDb.framePromptVariants.listByFrameWithAuthor(
        data.frameId,
        data.promptType
      );
    }
  );

const sequenceListInput = z.object({ sequenceId: ulidSchema });

export const listSequenceMusicPromptVariantsFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(sequenceListInput))
  .handler(
    async ({
      context,
      data,
    }): Promise<SequenceMusicPromptVariantWithAuthor[]> => {
      return await context.scopedDb.sequenceMusicPromptVariants.listBySequenceWithAuthor(
        data.sequenceId
      );
    }
  );

// ---------------------------------------------------------------------------
// Restore — append-only writes a new `'user-edit'` row using the chosen
// variant's text. The original variant row is never mutated.
// ---------------------------------------------------------------------------

const frameRestoreInput = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
  variantId: ulidSchema,
});

export const restoreFramePromptVariantFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameRestoreInput))
  .handler(async ({ context, data }) => {
    const chosen = await context.scopedDb.framePromptVariants.getByIdForFrame(
      data.variantId,
      data.frameId
    );
    if (!chosen) {
      throw new Error('Prompt variant not found for this frame');
    }

    const inserted = await context.scopedDb.framePromptVariants.write({
      frameId: data.frameId,
      promptType: chosen.promptType,
      text: chosen.text,
      components: null,
      parameters: null,
      source: 'user-edit',
      createdBy: context.user.id,
    });
    return { variantId: inserted.id };
  });

const sequenceRestoreInput = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

export const restoreSequenceMusicPromptVariantFn = createServerFn({
  method: 'POST',
})
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(sequenceRestoreInput))
  .handler(async ({ context, data }) => {
    const chosen =
      await context.scopedDb.sequenceMusicPromptVariants.getByIdForSequence(
        data.variantId,
        data.sequenceId
      );
    if (!chosen) {
      throw new Error('Music prompt variant not found for this sequence');
    }

    const inserted = await context.scopedDb.sequenceMusicPromptVariants.write({
      sequenceId: data.sequenceId,
      prompt: chosen.prompt,
      tags: chosen.tags,
      source: 'user-edit',
      createdBy: context.user.id,
    });
    return { variantId: inserted.id };
  });

// ---------------------------------------------------------------------------
// Regenerate — fires a workflow with the current upstream context. The
// workflow lands a `'regenerated'` row with a populated `input_hash`.
// ---------------------------------------------------------------------------

const frameRegenerateInput = z.object({
  sequenceId: ulidSchema,
  frameId: ulidSchema,
  promptType: promptTypeSchema,
});

export const regenerateFramePromptFn = createServerFn({ method: 'POST' })
  .middleware([frameAccessMiddleware])
  .inputValidator(zodValidator(frameRegenerateInput))
  .handler(async ({ context, data }) => {
    const { frame, sequence, scopedDb, user, teamId } = context;

    if (!frame.metadata) {
      throw new Error('Frame has no scene metadata to regenerate from');
    }

    const ctx = await loadFramePromptContext({
      scopedDb,
      sequence,
      scene: frame.metadata,
    });

    const baseInput:
      | VisualPromptSceneWorkflowInput
      | MotionPromptSceneWorkflowInput = {
      userId: user.id,
      teamId,
      sequenceId: sequence.id,
      frameId: frame.id,
      scene: frame.metadata,
      aspectRatio: sequence.aspectRatio,
      characterBible: ctx.characterBible,
      locationBible: ctx.locationBible,
      elementBible: ctx.elementBible,
      styleConfig: ctx.styleConfig,
      analysisModelId:
        getAnalysisModelById(ctx.analysisModel)?.id ?? DEFAULT_ANALYSIS_MODEL,
    };

    const urlPath =
      data.promptType === 'visual'
        ? '/visual-prompt-scene'
        : '/motion-prompt-scene';

    const workflowRunId = await triggerWorkflow(urlPath, baseInput, {
      deduplicationId: `prompt-${data.promptType}-${frame.id}-${Date.now()}`,
      label: buildWorkflowLabel(sequence.id),
    });

    return { workflowRunId };
  });

const sequenceRegenerateInput = z.object({ sequenceId: ulidSchema });

export const regenerateMusicPromptFn = createServerFn({ method: 'POST' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(sequenceRegenerateInput))
  .handler(async ({ context }) => {
    const { sequence, scopedDb, user, teamId } = context;

    const frames = await scopedDb.frames.listBySequence(sequence.id);
    const scenes = frames
      .map((f) => f.metadata)
      .filter((m): m is NonNullable<typeof m> => m !== null);
    if (scenes.length === 0) {
      throw new Error(
        'Sequence has no scenes to regenerate the music prompt from'
      );
    }
    const sceneSummaries = buildMusicSceneSummaries(scenes);

    const analysisModelId =
      getAnalysisModelById(sequence.analysisModel)?.id ??
      DEFAULT_ANALYSIS_MODEL;

    const workflowRunId = await triggerWorkflow<MusicPromptWorkflowInput>(
      '/music-prompt',
      {
        userId: user.id,
        teamId,
        sequenceId: sequence.id,
        sceneSummaries,
        analysisModelId,
      },
      {
        deduplicationId: `music-prompt-${sequence.id}-${Date.now()}`,
        label: buildWorkflowLabel(sequence.id),
      }
    );

    return { workflowRunId };
  });

// ---------------------------------------------------------------------------
// Music-prompt staleness — frame visual/motion staleness lives on
// `getFrameStalenessFn`, but music is a sequence-level artifact.
// ---------------------------------------------------------------------------

export const getMusicPromptStalenessFn = createServerFn({ method: 'GET' })
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(sequenceListInput))
  .handler(async ({ context }) => {
    const { sequence, scopedDb } = context;

    if (!sequence.musicPromptInputHash) {
      return { musicPrompt: false };
    }

    const frames = await scopedDb.frames.listBySequence(sequence.id);
    const scenes = frames
      .map((f) => f.metadata)
      .filter((m): m is NonNullable<typeof m> => m !== null);
    if (scenes.length === 0) {
      return { musicPrompt: false };
    }
    const sceneSummaries = buildMusicSceneSummaries(scenes);

    const latest = await scopedDb.sequenceMusicPromptVariants.getLatest(
      sequence.id
    );
    const analysisModel =
      latest?.analysisModel ??
      getAnalysisModelById(sequence.analysisModel)?.id ??
      DEFAULT_ANALYSIS_MODEL;

    const liveHash = await computeMusicPromptInputHash({
      sceneSummaries,
      analysisModel,
    });

    return { musicPrompt: liveHash !== sequence.musicPromptInputHash };
  });

// ---------------------------------------------------------------------------
// Field-level prompt diff for the divergence compare dialog.
//
// The variant carries `promptHash` (`simpleHash` of the prompt text); we look
// up the prompt-variants row whose `text` hashes to the same value and that
// was current at the variant's `createdAt`. Compared to the live cached
// prompt, that's the field-level diff for the divergence.
// ---------------------------------------------------------------------------

const variantPromptDiffInput = z.object({
  sequenceId: ulidSchema,
  variantId: ulidSchema,
});

export type VariantPromptDiff = {
  label: string;
  before: string;
  after: string;
} | null;

export const getDivergentVariantPromptDiffFn = createServerFn({
  method: 'GET',
})
  .middleware([sequenceAccessMiddleware])
  .inputValidator(zodValidator(variantPromptDiffInput))
  .handler(async ({ context, data }): Promise<VariantPromptDiff> => {
    const variant = await context.scopedDb.frameVariants.getById(
      data.variantId
    );
    if (!variant || variant.sequenceId !== data.sequenceId) return null;
    if (!variant.promptHash) return null;
    if (variant.variantType === 'audio') return null;

    const promptType = variant.variantType === 'image' ? 'visual' : 'motion';
    const candidates =
      await context.scopedDb.framePromptVariants.listCandidatesAtOrBefore(
        variant.frameId,
        promptType,
        variant.createdAt
      );

    const matched = candidates.find(
      (c) => simpleHash(c.text) === variant.promptHash
    );
    if (!matched) return null;

    const [frameRow] = await context.scopedDb.frames.getByIds([
      variant.frameId,
    ]);
    if (!frameRow) return null;
    const live =
      promptType === 'visual' ? frameRow.imagePrompt : frameRow.motionPrompt;
    if (!live) return null;
    if (live === matched.text) return null;

    return {
      label: promptType === 'visual' ? 'Visual prompt' : 'Motion prompt',
      before: matched.text,
      after: live,
    };
  });
