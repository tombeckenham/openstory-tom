/**
 * Scoped Character Sheet Variants Sub-module
 * CRUD for divergent character-sheet outputs (Stage 2 of workflow snapshots).
 */

import type { Database } from '@/lib/db/client';
import type {
  CharacterSheetVariant,
  NewCharacterSheetVariant,
} from '@/lib/db/schema';
import { characterSheetVariants } from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { insertDivergentRaceTolerant } from './divergent-insert';

export function createCharacterSheetVariantsMethods(db: Database) {
  return {
    listByCharacter: async (
      characterId: string
    ): Promise<CharacterSheetVariant[]> => {
      return db
        .select()
        .from(characterSheetVariants)
        .where(eq(characterSheetVariants.characterId, characterId));
    },

    listDivergentByCharacter: async (
      characterId: string
    ): Promise<CharacterSheetVariant[]> => {
      return db
        .select()
        .from(characterSheetVariants)
        .where(
          and(
            eq(characterSheetVariants.characterId, characterId),
            sql`${characterSheetVariants.divergedAt} IS NOT NULL`
          )
        );
    },

    insert: async (
      values: NewCharacterSheetVariant
    ): Promise<CharacterSheetVariant> => {
      const [row] = await db
        .insert(characterSheetVariants)
        .values(values)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!row) {
        throw new Error('Failed to insert character sheet variant');
      }
      return row;
    },

    /**
     * Idempotent on (characterId, model, inputHash) within the divergent
     * partial unique index. Tolerant to two failure modes:
     *
     *  - QStash step retry: the row was inserted on a previous attempt, the
     *    pre-check returns it.
     *  - Cross-run race: two divergent runs both pass the pre-check, one
     *    INSERT loses; the helper re-fetches and returns the winner's row.
     *
     * Pre-check + retry-fetch is required because drizzle's SQLite
     * `onConflictDoNothing` does not emit the partial-index `WHERE` predicate
     * after the target column list, so SQLite does not match the divergent
     * partial unique index and the conflict raises instead of being absorbed.
     */
    insertDivergent: async (
      values: NewCharacterSheetVariant & {
        inputHash: string;
        divergedAt: Date;
      }
    ): Promise<CharacterSheetVariant> => {
      const findExisting = () =>
        db
          .select()
          .from(characterSheetVariants)
          .where(
            and(
              eq(characterSheetVariants.characterId, values.characterId),
              eq(characterSheetVariants.model, values.model),
              eq(characterSheetVariants.inputHash, values.inputHash),
              sql`${characterSheetVariants.divergedAt} IS NOT NULL`
            )
          );
      return insertDivergentRaceTolerant({
        findExisting,
        insert: () =>
          db.insert(characterSheetVariants).values(values).returning(),
        errorMessage: 'Failed to insert character sheet variant',
      });
    },

    discard: async (id: string): Promise<void> => {
      await db
        .delete(characterSheetVariants)
        .where(eq(characterSheetVariants.id, id));
    },
  };
}
