import { createFileRoute } from '@tanstack/react-router';
import { getEnv } from '#env';
import { isLocalStorageServing } from '@/lib/storage/buckets';
import { serveFile } from '#storage';

/**
 * Serve route for stored media. Stored media URLs are origin-relative
 * (`/r2/<key>`, see #894), so every deployment serves its own media with
 * zero URL configuration:
 *
 * - Without `R2_PUBLIC_STORAGE_DOMAIN` (local dev, e2e, fresh deploy-button
 *   workers): stream the object straight from the R2 binding — local dev/e2e
 *   read local Miniflare state, so no remote R2 or credentials are needed.
 * - With a public CDN domain configured: redirect to it, so media bytes are
 *   served (and cached) by the R2 domain's edge instead of this worker, and
 *   rotating the domain only changes where the redirect points.
 */
export const Route = createFileRoute('/r2/$')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        const key = params._splat ?? '';
        if (!isLocalStorageServing()) {
          return Response.redirect(
            `https://${getEnv().R2_PUBLIC_STORAGE_DOMAIN}/${key}`,
            302
          );
        }
        return serveFile(key, request);
      },
    },
  },
});
