/**
 * Scoped Sequence Music Prompt Variants Sub-module
 *
 * Atomically appends a new revision row to `sequence_music_prompt_variants`
 * and updates the cached `musicPrompt` / `musicTags` columns on `sequences`
 * plus the `music_prompt_input_hash` column.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Stage 4: prompt versioning".
 */

import type { Database } from '@/lib/db/client';
import { sequenceMusicPromptVariants, sequences } from '@/lib/db/schema';
import type {
  PromptVariantSource,
  SequenceMusicPromptVariant,
} from '@/lib/db/schema';
import { desc, eq } from 'drizzle-orm';

export type WriteSequenceMusicPromptVariantInput = {
  sequenceId: string;
  prompt: string;
  tags?: string | null;
  components?: unknown;
  parameters?: unknown;
  source: PromptVariantSource;
  inputHash?: string | null;
  analysisModel?: string | null;
  createdBy?: string | null;
};

export function createSequenceMusicPromptVariantsMethods(db: Database) {
  return {
    /**
     * Insert a music prompt variant row and update the cached `musicPrompt`
     * / `musicTags` / `musicPromptInputHash` columns on `sequences` in a
     * single transaction. Returns the inserted row.
     */
    write: async (
      input: WriteSequenceMusicPromptVariantInput
    ): Promise<SequenceMusicPromptVariant> => {
      // Append + update is logically atomic; performed sequentially today
      // (see the equivalent note in frame-prompt-variants.ts).
      const [variant] = await db
        .insert(sequenceMusicPromptVariants)
        .values({
          sequenceId: input.sequenceId,
          prompt: input.prompt,
          tags: input.tags ?? null,
          components: input.components,
          parameters: input.parameters,
          source: input.source,
          inputHash: input.inputHash ?? null,
          analysisModel: input.analysisModel ?? null,
          createdBy: input.createdBy ?? null,
        })
        .returning();

      if (!variant) {
        throw new Error('Failed to insert sequence music prompt variant');
      }

      const nextHash =
        input.source === 'user-edit' ? null : (input.inputHash ?? null);

      await db
        .update(sequences)
        .set({
          musicPrompt: input.prompt,
          musicTags: input.tags ?? null,
          musicPromptInputHash: nextHash,
          updatedAt: new Date(),
        })
        .where(eq(sequences.id, input.sequenceId));

      return variant;
    },

    /** Revision history for a sequence's music prompt, newest first. */
    listBySequence: async (
      sequenceId: string
    ): Promise<SequenceMusicPromptVariant[]> => {
      return await db
        .select()
        .from(sequenceMusicPromptVariants)
        .where(eq(sequenceMusicPromptVariants.sequenceId, sequenceId))
        .orderBy(desc(sequenceMusicPromptVariants.createdAt));
    },

    /** Most recent music prompt variant, or null if none exists. */
    getLatest: async (
      sequenceId: string
    ): Promise<SequenceMusicPromptVariant | null> => {
      const [row] = await db
        .select()
        .from(sequenceMusicPromptVariants)
        .where(eq(sequenceMusicPromptVariants.sequenceId, sequenceId))
        .orderBy(desc(sequenceMusicPromptVariants.createdAt))
        .limit(1);
      return row ?? null;
    },
  };
}
