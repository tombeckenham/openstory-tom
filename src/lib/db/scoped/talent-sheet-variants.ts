/**
 * Scoped Talent Sheet Variants Sub-module
 * CRUD for divergent talent-sheet outputs (Stage 2 of workflow snapshots).
 */

import type { Database } from '@/lib/db/client';
import type {
  NewTalentSheetVariant,
  TalentSheetVariant,
} from '@/lib/db/schema';
import { talentSheetVariants } from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';

export function createTalentSheetVariantsMethods(db: Database) {
  return {
    listByTalentSheet: async (
      talentSheetId: string
    ): Promise<TalentSheetVariant[]> => {
      return db
        .select()
        .from(talentSheetVariants)
        .where(eq(talentSheetVariants.talentSheetId, talentSheetId));
    },

    listDivergentByTalentSheet: async (
      talentSheetId: string
    ): Promise<TalentSheetVariant[]> => {
      return db
        .select()
        .from(talentSheetVariants)
        .where(
          and(
            eq(talentSheetVariants.talentSheetId, talentSheetId),
            sql`${talentSheetVariants.divergedAt} IS NOT NULL`
          )
        );
    },

    insert: async (
      values: NewTalentSheetVariant
    ): Promise<TalentSheetVariant> => {
      const [row] = await db
        .insert(talentSheetVariants)
        .values(values)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!row) {
        throw new Error('Failed to insert talent sheet variant');
      }
      return row;
    },

    discard: async (id: string): Promise<void> => {
      await db
        .delete(talentSheetVariants)
        .where(eq(talentSheetVariants.id, id));
    },
  };
}
