/**
 * Sequence Video Variants Schema
 * Stores alternate merged-video outputs for a sequence so that divergent
 * results from `merge-video-workflow` are kept rather than overwriting the
 * live `sequences.mergedVideoUrl`.
 *
 * Promotion of a variant updates the matching `sequences.*` columns in place;
 * existing UI keeps reading those columns.
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

export const SEQUENCE_VIDEO_VARIANT_STATUSES = [
  'pending',
  'merging',
  'completed',
  'failed',
] as const;
export type SequenceVideoVariantStatus =
  (typeof SEQUENCE_VIDEO_VARIANT_STATUSES)[number];

export const sequenceVideoVariants = sqliteTable(
  'sequence_video_variants',
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

    // Identification of the merge config used
    workflow: text('workflow', { length: 100 }).notNull(),

    // Generation tracking
    status: text('status')
      .$type<SequenceVideoVariantStatus>()
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
    index('idx_sequence_video_variants_sequence').on(table.sequenceId),
    // Primary slot: at most one non-divergent row per (sequence, workflow).
    uniqueIndex('sequence_video_variants_primary_key')
      .on(table.sequenceId, table.workflow)
      .where(sql`${table.divergedAt} IS NULL`),
    // Divergent alternates keyed by input_hash.
    uniqueIndex('sequence_video_variants_divergent_key')
      .on(table.sequenceId, table.workflow, table.inputHash)
      .where(sql`${table.divergedAt} IS NOT NULL`),
  ]
);

export type SequenceVideoVariant = InferSelectModel<
  typeof sequenceVideoVariants
>;
export type NewSequenceVideoVariant = InferInsertModel<
  typeof sequenceVideoVariants
>;
