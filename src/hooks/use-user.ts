import { useQuery } from '@tanstack/react-query';
import { sessionQueryOptions } from '@/lib/auth/session-query';

/**
 * Hook for client components that need user data. Reads from the session cache
 * populated by `_protected/route.tsx` `beforeLoad` so SSR and client agree on
 * the auth state — see `getSessionFn` (isomorphic, reads cookies via
 * `getRequestHeaders()` on the server).
 */
export function useUser() {
  return useQuery({
    ...sessionQueryOptions,
    select: (session) => session?.user,
  });
}
