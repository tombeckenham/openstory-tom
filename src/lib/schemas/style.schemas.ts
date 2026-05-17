import {
  styles,
  StyleConfigSchema,
  StyleSampleVideoSchema,
} from '@/lib/db/schema';
import { createInsertSchema, createUpdateSchema } from 'drizzle-orm/zod';
import { z } from 'zod';

/**
 * Shared Zod schemas for style operations
 */

const tagsSchema = z.array(z.string()).nullish();
const useCasesSchema = z.array(z.string()).nullish();
const sampleVideosSchema = z.array(StyleSampleVideoSchema).nullish();

export const createStyleSchema = createInsertSchema(styles, {
  config: () => StyleConfigSchema,
  tags: () => tagsSchema,
  useCases: () => useCasesSchema,
  sampleVideos: () => sampleVideosSchema,
});
export const updateStyleSchema = createUpdateSchema(styles, {
  config: () => StyleConfigSchema.optional(),
  tags: () => tagsSchema,
  useCases: () => useCasesSchema,
  sampleVideos: () => sampleVideosSchema,
});

export type CreateStyleInput = z.infer<typeof createStyleSchema>;
export type UpdateStyleInput = z.infer<typeof updateStyleSchema>;
