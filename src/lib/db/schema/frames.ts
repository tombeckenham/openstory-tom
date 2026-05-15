/**
 * Frames Schema
 * Individual frames/shots within a sequence
 */

import { DEFAULT_IMAGE_MODEL } from '@/lib/ai/models';
import type { Scene } from '@/lib/ai/scene-analysis.schema';
import { type InferInsertModel, type InferSelectModel } from 'drizzle-orm';
import {
  index,
  integer,
  snakeCase,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';
import { generateId } from '../id';
import { sequences } from './sequences';

export const FRAME_GENERATION_STATUSES = [
  'pending',
  'generating',
  'completed',
  'failed',
] as const;
type FrameGenerationStatus = (typeof FRAME_GENERATION_STATUSES)[number];

/**
 * Frames table
 * Individual frames/shots within a sequence
 *
 * Each frame represents one scene from script analysis and stores:
 * - Visual content (thumbnailUrl for image, videoUrl for motion)
 * - Scene data in metadata field (populated progressively across 5 phases)
 * - Generation tracking information
 *
 * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
 */
export const frames = snakeCase.table(
  'frames',
  {
    id: text()
      .$defaultFn(() => generateId())
      .primaryKey()
      .notNull(),
    sequenceId: text()
      .notNull()
      .references(() => sequences.id, { onDelete: 'cascade' }),
    orderIndex: integer().notNull(),
    description: text(),
    durationMs: integer().default(3000),
    thumbnailUrl: text(),
    previewThumbnailUrl: text(), // Fast preview CDN URL (not stored in R2; URL may expire but column persists)
    thumbnailPath: text(), // R2 storage path (not signed URL)
    variantImageUrl: text(), // R2 storage path (not signed URL)
    variantImageStatus: text()
      .$type<FrameGenerationStatus>()
      .default('pending'),
    variantWorkflowRunId: text(),
    variantImageGeneratedAt: integer({
      mode: 'timestamp',
    }),
    variantImageError: text(),
    videoUrl: text(),
    videoPath: text(), // R2 storage path (not signed URL)
    // Thumbnail generation status tracking
    thumbnailStatus: text().$type<FrameGenerationStatus>().default('pending'),
    thumbnailWorkflowRunId: text(),
    thumbnailGeneratedAt: integer({
      mode: 'timestamp',
    }),
    thumbnailError: text(),
    imageModel: text({ length: 100 }).default(DEFAULT_IMAGE_MODEL).notNull(), // Model used for image generation
    imagePrompt: text(), // User-updated image prompt (overrides AI-generated prompt from metadata)
    // Video/motion generation status tracking
    videoStatus: text().$type<FrameGenerationStatus>().default('pending'),
    videoWorkflowRunId: text(),
    videoGeneratedAt: integer({
      mode: 'timestamp',
    }),
    videoError: text(),
    motionPrompt: text(), // User-updated motion prompt (overrides AI-generated prompt from metadata)
    motionModel: text({ length: 100 }), // Model used for motion/video generation (nullable - inherits from sequence if not set)
    // Audio/music generation status tracking
    audioUrl: text(),
    audioPath: text(), // R2 storage path (not signed URL)
    audioStatus: text().$type<FrameGenerationStatus>().default('pending'),
    audioWorkflowRunId: text(),
    audioGeneratedAt: integer({
      mode: 'timestamp',
    }),
    audioError: text(),
    audioModel: text({ length: 100 }), // Model used for music/audio generation (nullable)
    // SHA-256 of the inputs that produced each artifact; null when the
    // artifact has never been generated. See
    // docs/architecture/workflow-snapshots-and-content-hash-staleness.md.
    thumbnailInputHash: text(),
    variantImageInputHash: text(),
    videoInputHash: text(),
    audioInputHash: text(),
    // SHA-256 of the upstream context that produced the cached visual / motion
    // prompt (scene metadata + style config + character/location bible +
    // analysis model). When upstream context changes, the prompt itself is
    // flagged stale independently of the rendered image. Null when no AI
    // prompt has been generated yet, or when the most recent variant was a
    // user-edit (which has no upstream input surface).
    visualPromptInputHash: text(),
    motionPromptInputHash: text(),
    /**
     * Stores Scene data at various stages of progressive analysis.
     * Fields are populated progressively across 5 phases.
     * @see src/lib/ai/scene-analysis.schema.ts for Scene structure
     */
    metadata: text({ mode: 'json' }).$type<Scene>(),
    createdAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
    updatedAt: integer({ mode: 'timestamp' })
      .$defaultFn(() => new Date())
      .notNull(),
  },
  (table) => [
    // Compound index for efficient ordering queries
    index('idx_frames_order').on(table.sequenceId, table.orderIndex),
    index('idx_frames_sequence_id').on(table.sequenceId),
    // Unique constraint: one frame per sequence/order combination
    uniqueIndex('frames_sequence_id_order_index_key').on(
      table.sequenceId,
      table.orderIndex
    ),
  ]
);

// Override the inferred Frame type to use Scene for metadata
type InferredFrame = InferSelectModel<typeof frames>;
export type Frame = Omit<InferredFrame, 'metadata'> & {
  metadata: Scene | null; // Nullable until script analysis completes, fields populate progressively
};

type InferredNewFrame = InferInsertModel<typeof frames>;
export type NewFrame = Omit<InferredNewFrame, 'metadata'> & {
  metadata?: Scene | null; // Optional - can be null initially, populated during script analysis
};
