/**
 * Scoped Location Sheet Variants Sub-module
 * CRUD for divergent location-sheet outputs (Stage 2 of workflow snapshots).
 *
 * The variants table is parent-type-tagged: rows can belong to either a
 * `sequence_locations` row or a `location_library` row. Callers pass the
 * matching `parentType` to scope queries.
 */

import type { Database } from '@/lib/db/client';
import type {
  LocationSheetVariant,
  LocationSheetVariantParentType,
  NewLocationSheetVariant,
} from '@/lib/db/schema';
import { locationSheetVariants } from '@/lib/db/schema';
import { and, eq, sql } from 'drizzle-orm';
import { insertDivergentRaceTolerant } from './divergent-insert';

export function createLocationSheetVariantsMethods(db: Database) {
  return {
    listByParent: async (
      parentType: LocationSheetVariantParentType,
      parentId: string
    ): Promise<LocationSheetVariant[]> => {
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            eq(locationSheetVariants.parentType, parentType),
            eq(locationSheetVariants.parentId, parentId)
          )
        );
    },

    listDivergentByParent: async (
      parentType: LocationSheetVariantParentType,
      parentId: string
    ): Promise<LocationSheetVariant[]> => {
      return db
        .select()
        .from(locationSheetVariants)
        .where(
          and(
            eq(locationSheetVariants.parentType, parentType),
            eq(locationSheetVariants.parentId, parentId),
            sql`${locationSheetVariants.divergedAt} IS NOT NULL`
          )
        );
    },

    insert: async (
      values: NewLocationSheetVariant
    ): Promise<LocationSheetVariant> => {
      const [row] = await db
        .insert(locationSheetVariants)
        .values(values)
        .returning();
      // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- runtime guard
      if (!row) {
        throw new Error('Failed to insert location sheet variant');
      }
      return row;
    },

    /**
     * Idempotent on (parentType, parentId, model, inputHash) within the
     * divergent partial unique index. Tolerant to QStash step retry and
     * cross-run race; see `divergent-insert.ts` for the rationale.
     */
    insertDivergent: async (
      values: NewLocationSheetVariant & {
        inputHash: string;
        divergedAt: Date;
      }
    ): Promise<LocationSheetVariant> => {
      const findExisting = () =>
        db
          .select()
          .from(locationSheetVariants)
          .where(
            and(
              eq(locationSheetVariants.parentType, values.parentType),
              eq(locationSheetVariants.parentId, values.parentId),
              eq(locationSheetVariants.model, values.model),
              eq(locationSheetVariants.inputHash, values.inputHash),
              sql`${locationSheetVariants.divergedAt} IS NOT NULL`
            )
          );
      return insertDivergentRaceTolerant({
        findExisting,
        insert: () =>
          db.insert(locationSheetVariants).values(values).returning(),
        errorMessage: 'Failed to insert location sheet variant',
      });
    },

    discard: async (id: string): Promise<void> => {
      await db
        .delete(locationSheetVariants)
        .where(eq(locationSheetVariants.id, id));
    },
  };
}
