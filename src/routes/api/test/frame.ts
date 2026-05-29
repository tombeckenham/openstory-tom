import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { z } from 'zod';
import { createTestFrame } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateFrameSchema = z.object({
  sequenceId: z.string(),
  orderIndex: z.number(),
  thumbnailUrl: z.string().optional(),
  variantImageUrl: z.string().nullable().optional(),
  variantImageStatus: z
    .enum(['pending', 'generating', 'completed', 'failed'])
    .optional(),
});

export const Route = createFileRoute('/api/test/frame')({
  server: {
    middleware: [testOnlyGuard],
    handlers: {
      POST: async ({ request }) => {
        const { sequenceId, orderIndex, ...options } = CreateFrameSchema.parse(
          await request.json()
        );

        if (!sequenceId || typeof orderIndex !== 'number') {
          return json(
            { error: 'sequenceId and orderIndex are required' },
            { status: 400 }
          );
        }

        const frame = await createTestFrame(sequenceId, orderIndex, options);
        return json(frame);
      },
    },
  },
});
