import { createFileRoute } from '@tanstack/react-router';
import { isLocalStorageServing } from '@/lib/storage/buckets';
import { serveFile } from '#storage';

/**
 * Local stand-in for the R2 public CDN domain.
 *
 * When `R2_PUBLIC_STORAGE_DOMAIN` is unset (local dev + e2e), `getPublicUrl()`
 * returns `${VITE_APP_URL}/r2/<key>` and this route streams the object from
 * the R2 binding — which is local Miniflare state, so no remote R2 or
 * Cloudflare credentials are needed. In production the domain is always set,
 * publicUrls point at the CDN, and this route answers 404.
 */
export const Route = createFileRoute('/r2/$')({
  server: {
    handlers: {
      GET: async ({ params, request }) => {
        if (!isLocalStorageServing()) {
          return new Response('Not found', { status: 404 });
        }
        return serveFile(params._splat ?? '', request);
      },
    },
  },
});
