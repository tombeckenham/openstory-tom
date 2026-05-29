import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { z } from 'zod';
import { createTestTalent } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateTalentSchema = z.object({
  teamId: z.string(),
  name: z.string(),
});

export const Route = createFileRoute('/api/test/talent')({
  server: {
    middleware: [testOnlyGuard],
    handlers: {
      /**
       * POST /api/test/talent
       * Body: { teamId: string; name: string }
       */
      POST: async ({ request }) => {
        const { teamId, name } = CreateTalentSchema.parse(await request.json());

        if (!teamId || !name) {
          return json(
            { error: 'teamId and name are required' },
            { status: 400 }
          );
        }

        const created = await createTestTalent(teamId, name);
        return json(created);
      },
    },
  },
});
