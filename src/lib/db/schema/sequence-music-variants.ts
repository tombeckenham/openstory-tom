/**
 * Sequence Music Variants Schema
 * Stores alternate music tracks for a sequence so that divergent results from
 * `music-workflow` are kept rather than overwriting the live `sequences.musicUrl`.
 *
 * Promotion of a variant updates the matching `sequences.music*` columns
 * in place; existing UI keeps reading those columns.
 */

import { sql, type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { sequences } from './sequences';

// Music is generated, not merged — no 'merging' status (which is video-only).
export const SEQUENCE_MUSIC_VARIANT_STATUSES = [
  'pending',
  'completed',
  'failed',
] as const;
export type SequenceMusicVariantStatus =
  (typeof SEQUENCE_MUSIC_VARIANT_STATUSES)[number];

export const sequenceMusicVariants = snakeCase.table(
  'sequence_music_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),

    // Output
    url: text(),
    storagePath: text(),

    // Inputs that produced this variant (kept on the row for promotion)
    prompt: text(),
    tags: text(),
    durationSeconds: integer(),
    model: text({ length: 100 }).notNull(),

    // Generation tracking
    status: text()
      .$type<SequenceMusicVariantStatus>()
      .default('pending')
      .notNull(),
    workflowRunId: text(),
    generatedAt: integer({ mode: 'timestamp' }),
    error: text(),

    // Staleness detection
    inputHash: text(),
    divergedAt: integer({ mode: 'timestamp' }),
    // Soft-delete marker for divergent alternates the user has dismissed.
    // Mirrors `frame_variants.discarded_at` so the toast Undo flow can clear
    // the row without losing the artifact.
    discardedAt: integer({ mode: 'timestamp' }),

    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    index('idx_sequence_music_variants_sequence').on(table.sequenceId),
    // Primary slot: at most one non-divergent row per (sequence, model).
    uniqueIndex('sequence_music_variants_primary_key')
      .on(table.sequenceId, table.model)
      .where(sql`${table.divergedAt} IS NULL`),
    // Divergent alternates keyed by input_hash.
    uniqueIndex('sequence_music_variants_divergent_key')
      .on(table.sequenceId, table.model, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type SequenceMusicVariant = InferSelectModel<
  typeof sequenceMusicVariants
>;
export type NewSequenceMusicVariant = InferInsertModel<
  typeof sequenceMusicVariants
>;
