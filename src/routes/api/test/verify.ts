import { createFileRoute } from '@tanstack/react-router';
import { json } from '@tanstack/react-start';
import { z } from 'zod';
import { createOtpVerification } from '@/lib/test/seed';
import { testOnlyGuard } from './route';

const VerifySchema = z.object({
  email: z.string(),
  otp: z.string(),
});

export const Route = createFileRoute('/api/test/verify')({
  server: {
    middleware: [testOnlyGuard],
    handlers: {
      /**
       * POST /api/test/verify
       * Body: { email: string; otp: string }
       * Creates a verification record so the test auth flow can "login" with a known OTP.
       */
      POST: async ({ request }) => {
        const { email, otp } = VerifySchema.parse(await request.json());

        if (!email || !otp) {
          return json({ error: 'email and otp are required' }, { status: 400 });
        }

        await createOtpVerification(email, otp);
        return json({ success: true });
      },
    },
  },
});
