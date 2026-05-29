import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { z } from 'zod';
import { createTestStyle } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateStyleSchema = z.object({
  teamId: z.string(),
});

export const Route = createFileRoute('/api/test/style')({
  server: {
    middleware: [testOnlyGuard],
    handlers: {
      POST: async ({ request }) => {
        const { teamId } = CreateStyleSchema.parse(await request.json());
        if (!teamId) {
          return json({ error: 'teamId is required' }, { status: 400 });
        }

        const style = await createTestStyle(teamId);
        return json(style);
      },
    },
  },
});
