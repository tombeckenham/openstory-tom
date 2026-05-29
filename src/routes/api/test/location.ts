import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { z } from 'zod';
import { createTestLocation } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const CreateLocationSchema = z.object({
  teamId: z.string(),
  name: z.string(),
});

export const Route = createFileRoute('/api/test/location')({
  server: {
    middleware: [testOnlyGuard],
    handlers: {
      POST: async ({ request }) => {
        const { teamId, name } = CreateLocationSchema.parse(
          await request.json()
        );

        if (!teamId || !name) {
          return json(
            { error: 'teamId and name are required' },
            { status: 400 }
          );
        }

        const created = await createTestLocation(teamId, name);
        return json(created);
      },
    },
  },
});
