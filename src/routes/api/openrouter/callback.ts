/**
 * OpenRouter OAuth PKCE Callback
 * GET /api/openrouter/callback - Handles the redirect from OpenRouter after user authorization
 *
 * OpenRouter redirects here with ?code=... query parameter.
 * We exchange the code for an API key and redirect the user back to settings.
 */

import { authWithTeamRequestMiddleware } from '@/functions/middleware';
import { completeOpenRouterOAuth } from '@/functions/openrouter-oauth-callback';
import { createFileRoute } from '@tanstack/react-router';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'api', 'openrouter', 'callback']);

function redirectResponse(path: string): Response {
  return new Response(null, {
    status: 302,
    headers: { Location: path },
  });
}

export const Route = createFileRoute('/api/openrouter/callback')({
  server: {
    middleware: [authWithTeamRequestMiddleware],
    handlers: {
      GET: async ({ request, context }) => {
        const url = new URL(request.url);
        const code = url.searchParams.get('code');

        if (!code) {
          return redirectResponse(
            '/settings/api-keys?error=openrouter_oauth_missing_code'
          );
        }

        try {
          await completeOpenRouterOAuth(context.teamId, code, context.scopedDb);

          return redirectResponse(
            '/settings/api-keys?success=openrouter_connected'
          );
        } catch (error) {
          logger.error('Callback error:', { err: error });
          return redirectResponse(
            '/settings/api-keys?error=openrouter_oauth_failed'
          );
        }
      },
    },
  },
});
