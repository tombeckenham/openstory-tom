/**
 * Authentication Navigation Utilities
 * Helpers for navigating to auth pages with redirect preservation
 */

import { Route as loginRoute } from '@/routes/_auth/login';

/**
 * Get the redirect URL from query params
 * For use in auth pages to read the intended destination
 * @param searchParams - URLSearchParams or query params object
 * @returns Redirect path or default (/sequences/new)
 */
export function getRedirectFromParams(
  searchParams: URLSearchParams | Record<string, string | string[] | undefined>
): string {
  let redirectTo: string | null = null;

  if (searchParams instanceof URLSearchParams) {
    redirectTo = searchParams.get('redirectTo');
  } else if (typeof searchParams === 'object' && searchParams.redirectTo) {
    const value = searchParams.redirectTo;
    redirectTo = Array.isArray(value) ? (value[0] ?? null) : value;
  }

  // Validate redirect URL to prevent open redirects
  if (redirectTo) {
    // Only allow relative URLs (starting with /)
    if (redirectTo.startsWith('/') && !redirectTo.startsWith('//')) {
      // Prevent redirecting back to auth pages
      if (!redirectTo.startsWith(loginRoute.fullPath)) {
        return redirectTo;
      }
    }
  }

  return '/sequences/new';
}
