/**
 * Sequence Music Prompt Variants Schema
 *
 * One row per revision of a sequence's music prompt + tags. The current
 * "active" prompt is mirrored on `sequences.musicPrompt` / `sequences.musicTags`
 * for read-path simplicity; this table stores the full revision history.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Stage 4: prompt versioning".
 */

import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import { index, integer, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { user } from './auth';
import {
  PROMPT_VARIANT_SOURCES,
  type PromptVariantSource,
} from './frame-prompt-variants';
import { sequences } from './sequences';

export const SEQUENCE_MUSIC_PROMPT_TYPE = 'music' as const;
export type SequenceMusicPromptType = typeof SEQUENCE_MUSIC_PROMPT_TYPE;

export { PROMPT_VARIANT_SOURCES };
export type { PromptVariantSource };

export const sequenceMusicPromptVariants = sqliteTable(
  'sequence_music_prompt_variants',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text('sequence_id')
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),

    promptType: text('prompt_type')
      .$type<SequenceMusicPromptType>()
      .default(SEQUENCE_MUSIC_PROMPT_TYPE)
      .notNull(),

    // The natural-language music prompt.
    prompt: text('prompt').notNull(),
    // Comma-separated music tags string (mirrors `sequences.musicTags`).
    tags: text('tags'),

    // Structured components / parameters (e.g. style/mood/atmosphere/duration).
    components: text('components', { mode: 'json' }).$type<unknown>(),
    parameters: text('parameters', { mode: 'json' }).$type<unknown>(),

    source: text('source').$type<PromptVariantSource>().notNull(),

    // SHA-256 of the upstream context (musicDesign + analysis model) for AI
    // prompts; null for user-edits.
    inputHash: text('input_hash'),

    analysisModel: text('analysis_model', { length: 100 }),

    createdAt: integer('created_at', { mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    createdBy: text('created_by').references(() => user.id, {
      onDelete: 'set null',
    }),
  },
  (table) => [
    index('idx_sequence_music_prompt_variants_sequence_created').on(
      table.sequenceId,
      table.createdAt
    ),
  ]
);

export type SequenceMusicPromptVariant = InferSelectModel<
  typeof sequenceMusicPromptVariants
>;
export type NewSequenceMusicPromptVariant = InferInsertModel<
  typeof sequenceMusicPromptVariants
>;
