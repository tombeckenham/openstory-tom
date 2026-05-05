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
import { insertDivergentRaceTolerant } from './divergent-insert';

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

    /**
     * Idempotent on (talentSheetId, model, inputHash) within the divergent
     * partial unique index. Tolerant to QStash step retry and cross-run race;
     * see `divergent-insert.ts` for the rationale.
     */
    insertDivergent: async (
      values: NewTalentSheetVariant & {
        inputHash: string;
        divergedAt: Date;
      }
    ): Promise<TalentSheetVariant> => {
      const findExisting = () =>
        db
          .select()
          .from(talentSheetVariants)
          .where(
            and(
              eq(talentSheetVariants.talentSheetId, values.talentSheetId),
              eq(talentSheetVariants.model, values.model),
              eq(talentSheetVariants.inputHash, values.inputHash),
              sql`${talentSheetVariants.divergedAt} IS NOT NULL`
            )
          );
      return insertDivergentRaceTolerant({
        findExisting,
        insert: () => db.insert(talentSheetVariants).values(values).returning(),
        errorMessage: 'Failed to insert talent sheet variant',
      });
    },

    discard: async (id: string): Promise<void> => {
      await db
        .delete(talentSheetVariants)
        .where(eq(talentSheetVariants.id, id));
    },
  };
}
