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
  sqliteTable,
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

export const sequenceMusicVariants = sqliteTable(
  'sequence_music_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),

    // Output
    url: text('url'),
    storagePath: text('storage_path'),

    // Inputs that produced this variant (kept on the row for promotion)
    prompt: text('prompt'),
    tags: text('tags'),
    durationSeconds: integer('duration_seconds'),
    model: text('model', { length: 100 }).notNull(),

    // Generation tracking
    status: text('status')
      .$type<SequenceMusicVariantStatus>()
      .default('pending')
      .notNull(),
    workflowRunId: text('workflow_run_id'),
    generatedAt: integer('generated_at', { mode: 'timestamp' }),
    error: text('error'),

    // Staleness detection
    inputHash: text('input_hash'),
    divergedAt: integer('diverged_at', { mode: 'timestamp' }),
    // Soft-delete marker for divergent alternates the user has dismissed.
    // Mirrors `frame_variants.discarded_at` so the toast Undo flow can clear
    // the row without losing the artifact.
    discardedAt: integer('discarded_at', { mode: 'timestamp' }),

    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer('updated_at', { mode: 'timestamp' })
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
