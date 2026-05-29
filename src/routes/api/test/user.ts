import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { z } from 'zod';
import { cleanupTestUser, createTestUser } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const DeleteUserSchema = z.object({
  userId: z.string(),
  teamId: z.string(),
});

export const Route = createFileRoute('/api/test/user')({
  server: {
    middleware: [testOnlyGuard],
    handlers: {
      /**
       * POST /api/test/user
       * Body: { name?: string }
       * Creates a test user + team + credits. Returns the created identifiers.
       */
      POST: async ({ request }) => {
        let body: { name?: string } = {};
        try {
          body = await request.json();
        } catch {
          // ok, use defaults
        }

        const created = await createTestUser({ name: body.name });
        return json(created);
      },

      /**
       * DELETE /api/test/user
       * Body: { userId: string; teamId: string }
       * Cleans up a previously created test user.
       */
      DELETE: async ({ request }) => {
        const { userId, teamId } = DeleteUserSchema.parse(await request.json());

        if (!userId || !teamId) {
          return json(
            { error: 'userId and teamId are required' },
            { status: 400 }
          );
        }

        await cleanupTestUser(userId, teamId);
        return json({ success: true });
      },
    },
  },
});
