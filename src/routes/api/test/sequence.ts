import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { z } from 'zod';
import { createTestSequence } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateSequenceSchema = z.object({
  teamId: z.string(),
  userId: z.string(),
  title: z.string().optional(),
});

export const Route = createFileRoute('/api/test/sequence')({
  server: {
    middleware: [testOnlyGuard],
    handlers: {
      /**
       * POST /api/test/sequence
       * Body: { teamId: string; userId: string; title?: string }
       */
      POST: async ({ request }) => {
        const { teamId, userId, title } = CreateSequenceSchema.parse(
          await request.json()
        );

        if (!teamId || !userId) {
          return json(
            { error: 'teamId and userId are required' },
            { status: 400 }
          );
        }

        const created = await createTestSequence(teamId, userId, title);
        return json(created);
      },
    },
  },
});
