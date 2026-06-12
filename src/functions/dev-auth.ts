/**
 * Dev Auth Server Function
 * Reports whether the dev fixed-OTP sign-in is active (see devFixedOtp in
 * src/lib/auth/config.ts) so the login form can show the zero-friction note
 * and skip the auto-sign-in attempt when the real email-OTP flow is on
 * (EMAIL_FROM set). In production builds `isDevFixedOtpActive` collapses to
 * `false` (`import.meta.env.DEV` is define-replaced), so this discloses
 * nothing.
 */

import { isDevFixedOtpActive } from '@/lib/auth/config';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';

export const getDevFixedOtpStatusFn = createServerFn({ method: 'GET' }).handler(
  () => ({ fixedOtp: isDevFixedOtpActive(getRequest()) })
);
