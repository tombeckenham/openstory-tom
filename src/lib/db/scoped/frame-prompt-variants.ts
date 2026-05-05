/**
 * Scoped Frame Prompt Variants Sub-module
 *
 * Appends a new revision row to `frame_prompt_variants` and updates the
 * cached pointer column on `frames` (`imagePrompt` for visual prompts,
 * `motionPrompt` for motion prompts) plus the matching
 * `*_prompt_input_hash` column. The two writes are sequential, not
 * transactional — see `write` for the durability story.
 *
 * Callers go through these helpers instead of writing the cached column
 * directly so prompt history is never lost. Read-path (read the cached
 * column) is unchanged.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § prompt versioning.
 */

import type { MotionPromptParameters } from '@/lib/ai/scene-analysis.schema';
import type { Database } from '@/lib/db/client';
import { framePromptVariants, frames, user } from '@/lib/db/schema';
import type {
  FramePromptType,
  FramePromptVariant,
  FramePromptVariantComponents,
} from '@/lib/db/schema';
import { and, desc, eq, lte } from 'drizzle-orm';

type WriteFramePromptVariantBase = {
  frameId: string;
  promptType: FramePromptType;
  text: string;
  components?: FramePromptVariantComponents | null;
  parameters?: MotionPromptParameters | null;
  createdBy?: string | null;
};

/**
 * AI-generated and regenerated rows must carry the upstream-context hash and
 * the analysis model that produced the prompt — without these, the cached
 * `*_prompt_input_hash` column on `frames` is meaningless and staleness
 * detection silently breaks. User-edits have no upstream input surface and
 * forbid both fields so they cannot be set by mistake.
 *
 * Restored rows carry the source variant's hash + analysisModel verbatim so
 * the cached `*_prompt_input_hash` column keeps tracking the upstream context
 * that originally produced the prompt — restoring an old AI prompt must NOT
 * silently disable staleness detection. Both fields can be null when the
 * source is itself a user-edit (which never had a hash to begin with).
 */
export type WriteFramePromptVariantInput = WriteFramePromptVariantBase &
  (
    | {
        source: 'ai-generated' | 'regenerated';
        inputHash: string;
        analysisModel: string;
      }
    | {
        source: 'user-edit';
        inputHash?: never;
        analysisModel?: never;
      }
    | {
        source: 'restored';
        inputHash: string | null;
        analysisModel: string | null;
      }
  );

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
     * Append a new prompt variant row and update the cached pointer on
     * `frames`. Returns the inserted (or pre-existing matching) row.
     *
     * Durability: the insert + update pair is sequential, not transactional.
     * The variant row is the source of truth; the cached column on `frames`
     * is a read-path optimization. To make QStash retries safe, AI-generated
     * rows are deduped by the unique partial index on
     * `(frame_id, prompt_type, input_hash) WHERE input_hash IS NOT NULL`:
     * an insert that conflicts with an existing row no-ops, the existing row
     * is fetched, and the cached pointer is updated as normal.
     */
    write: async (
      input: WriteFramePromptVariantInput
    ): Promise<FramePromptVariant> => {
      const cached = cachedColumnsForType(input.promptType);

      const nextHash = input.source === 'user-edit' ? null : input.inputHash;
      const analysisModel =
        input.source === 'user-edit' ? null : input.analysisModel;
      // 'restored' may carry a null hash (when restoring a user-edit row);
      // treat it like a user-edit for the conflict-recovery select fallback.

      // Append first so a crash can't leave a stale pointer with no row
      // behind it. The reverse order would be unrecoverable.
      const [inserted] = await db
        .insert(framePromptVariants)
        .values({
          frameId: input.frameId,
          promptType: input.promptType,
          text: input.text,
          components: input.components,
          parameters: input.parameters,
          source: input.source,
          inputHash: nextHash,
          analysisModel,
          createdBy: input.createdBy ?? null,
        })
        .onConflictDoNothing()
        .returning();

      let variant: FramePromptVariant | undefined = inserted;
      if (!variant && nextHash !== null) {
        const [existing] = await db
          .select()
          .from(framePromptVariants)
          .where(
            and(
              eq(framePromptVariants.frameId, input.frameId),
              eq(framePromptVariants.promptType, input.promptType),
              eq(framePromptVariants.inputHash, nextHash)
            )
          )
          .limit(1);
        variant = existing;
      }

      if (!variant) {
        throw new Error('Failed to insert frame prompt variant');
      }

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

    /**
     * History list for the UI — joins author name. Newest first.
     */
    listByFrameWithAuthor: async (
      frameId: string,
      promptType: FramePromptType
    ): Promise<
      Array<FramePromptVariant & { createdByName: string | null }>
    > => {
      const rows = await db
        .select({ variant: framePromptVariants, createdByName: user.name })
        .from(framePromptVariants)
        .leftJoin(user, eq(framePromptVariants.createdBy, user.id))
        .where(
          and(
            eq(framePromptVariants.frameId, frameId),
            eq(framePromptVariants.promptType, promptType)
          )
        )
        .orderBy(desc(framePromptVariants.createdAt));
      return rows.map((r) => ({
        ...r.variant,
        createdByName: r.createdByName,
      }));
    },

    /** Fetch a single variant scoped to its frame. */
    getByIdForFrame: async (
      variantId: string,
      frameId: string
    ): Promise<FramePromptVariant | null> => {
      const [row] = await db
        .select()
        .from(framePromptVariants)
        .where(
          and(
            eq(framePromptVariants.id, variantId),
            eq(framePromptVariants.frameId, frameId)
          )
        )
        .limit(1);
      return row ?? null;
    },

    /**
     * Candidates for matching a `frame_variants.promptHash` (`simpleHash` of
     * the prompt text) — pulls prompt variants of the right type that existed
     * at or before `cutoff`, newest first. Caller filters by simpleHash.
     */
    listCandidatesAtOrBefore: async (
      frameId: string,
      promptType: FramePromptType,
      cutoff: Date,
      limit = 50
    ): Promise<FramePromptVariant[]> => {
      return await db
        .select()
        .from(framePromptVariants)
        .where(
          and(
            eq(framePromptVariants.frameId, frameId),
            eq(framePromptVariants.promptType, promptType),
            lte(framePromptVariants.createdAt, cutoff)
          )
        )
        .orderBy(desc(framePromptVariants.createdAt))
        .limit(limit);
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
