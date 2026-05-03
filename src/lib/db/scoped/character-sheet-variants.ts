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

    discard: async (id: string): Promise<void> => {
      await db
        .delete(characterSheetVariants)
        .where(eq(characterSheetVariants.id, id));
    },
  };
}
