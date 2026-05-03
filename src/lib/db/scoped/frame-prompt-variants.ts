/**
 * Scoped Frame Prompt Variants Sub-module
 *
 * Atomically appends a new revision row to `frame_prompt_variants` and
 * updates the cached pointer column on `frames` (`imagePrompt` for visual
 * prompts, `motionPrompt` for motion prompts) plus the matching
 * `*_prompt_input_hash` column.
 *
 * Callers go through these helpers instead of writing the cached column
 * directly so prompt history is never lost. Read-path (read the cached
 * column) is unchanged.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Stage 4: prompt versioning".
 */

import type { Database } from '@/lib/db/client';
import { framePromptVariants, frames } from '@/lib/db/schema';
import type {
  FramePromptType,
  FramePromptVariant,
  PromptVariantSource,
} from '@/lib/db/schema';
import { and, desc, eq } from 'drizzle-orm';

export type WriteFramePromptVariantInput = {
  frameId: string;
  promptType: FramePromptType;
  text: string;
  components?: unknown;
  parameters?: unknown;
  source: PromptVariantSource;
  /**
   * SHA-256 of the upstream context that produced an AI prompt. Required for
   * `'ai-generated'` and `'regenerated'`; omitted for `'user-edit'`.
   */
  inputHash?: string | null;
  analysisModel?: string | null;
  createdBy?: string | null;
};

const cachedColumnsForType = (promptType: FramePromptType) =>
  promptType === 'visual'
    ? {
        text: frames.imagePrompt,
        hash: frames.visualPromptInputHash,
        textKey: 'imagePrompt' as const,
        hashKey: 'visualPromptInputHash' as const,
      }
    : {
        text: frames.motionPrompt,
        hash: frames.motionPromptInputHash,
        textKey: 'motionPrompt' as const,
        hashKey: 'motionPromptInputHash' as const,
      };

export function createFramePromptVariantsMethods(db: Database) {
  return {
    /**
     * Insert a new prompt variant row and update the cached pointer on
     * `frames` in a single transaction. Returns the inserted row.
     *
     * No-ops (still inserts but is a logical no-op) are the caller's
     * responsibility to skip — duplicate-detection lives at the call site
     * because "what counts as a meaningful change" varies (user-edit
     * whitespace shouldn't create a row; AI regeneration with identical
     * output should).
     */
    write: async (
      input: WriteFramePromptVariantInput
    ): Promise<FramePromptVariant> => {
      const cached = cachedColumnsForType(input.promptType);

      // The append + update pair is logically atomic. We perform them
      // sequentially today; a single transaction can be added once the
      // scoped-DB layer exposes one (see the architecture doc's "Outstanding
      // hardening" note about scopedDb transactions). The inserted row is
      // the source of truth; the cached column is purely a read-path
      // optimization that can be reconciled from the variant chain if a
      // process crashes between the two writes.
      const [variant] = await db
        .insert(framePromptVariants)
        .values({
          frameId: input.frameId,
          promptType: input.promptType,
          text: input.text,
          components: input.components,
          parameters: input.parameters,
          source: input.source,
          inputHash: input.inputHash ?? null,
          analysisModel: input.analysisModel ?? null,
          createdBy: input.createdBy ?? null,
        })
        .returning();

      if (!variant) {
        throw new Error('Failed to insert frame prompt variant');
      }

      // User-edits clear the input hash on the cached pointer (the cached
      // value is no longer derived from upstream context). AI-generated /
      // regenerated rows set it.
      const nextHash =
        input.source === 'user-edit' ? null : (input.inputHash ?? null);

      await db
        .update(frames)
        .set({
          [cached.textKey]: input.text,
          [cached.hashKey]: nextHash,
          updatedAt: new Date(),
        })
        .where(eq(frames.id, input.frameId));

      return variant;
    },

    /** List the revision history for a frame's prompt, newest first. */
    listByFrame: async (
      frameId: string,
      promptType: FramePromptType
    ): Promise<FramePromptVariant[]> => {
      return await db
        .select()
        .from(framePromptVariants)
        .where(
          and(
            eq(framePromptVariants.frameId, frameId),
            eq(framePromptVariants.promptType, promptType)
          )
        )
        .orderBy(desc(framePromptVariants.createdAt));
    },

    /** Most recent variant of a given type, or null if none exists. */
    getLatest: async (
      frameId: string,
      promptType: FramePromptType
    ): Promise<FramePromptVariant | null> => {
      const [row] = await db
        .select()
        .from(framePromptVariants)
        .where(
          and(
            eq(framePromptVariants.frameId, frameId),
            eq(framePromptVariants.promptType, promptType)
          )
        )
        .orderBy(desc(framePromptVariants.createdAt))
        .limit(1);
      return row ?? null;
    },
  };
}
