/**
 * Test Database Client for E2E Tests
 *
 * IMPORTANT: There are TWO distinct ways tests touch the D1 database:
 *
 * 1. Through the app (the intended/safe path):
 *    Browser (`page.goto`, clicks, etc.) → HTTP → server handlers → getDb()
 *    This goes through the SINGLE Miniflare instance started by
 *    @cloudflare/vite-plugin inside the `vite dev` / `vite preview` webServer.
 *
 * 2. DIRECTLY from test code (the source of the remaining locking risk):
 *    Node.js Playwright worker processes import this module and call
 *    `getPlatformProxy({ environment: 'test' })` themselves. With
 *    `fullyParallel: true` + multiple workers (4 locally, 2 in CI), this
 *    means MULTIPLE independent workerd/Miniflare processes opening the
 *    same SQLite file under .wrangler/state/v3/d1/... while the app is
 *    also writing.
 *
 * This file is Path #2. It exists for pragmatic reasons (creating users,
 * teams, sequences, talent, frames, etc. via the real UI is slow and brittle),
 * but it is the reason we still carry some SQLITE_BUSY risk on the test side.
 *
 * See also:
 * - playwright.config.ts (why we use vite dev/preview instead of wrangler dev)
 * - e2e/fixtures/*.fixture.ts (the direct insert/delete calls)
 * - scripts/migrate-local-d1.ts and scripts/seed.ts (also use getPlatformProxy)
 */

import { drizzle } from 'drizzle-orm/d1';
import { getPlatformProxy } from 'wrangler';
import { relations } from '@/lib/db/schema/relations';

// remoteBindings: false — fixtures only touch local D1; R2 traffic happens
// through the worker (storage-cloudflare.ts → r2-mock sidecar), not via this
// proxy. Avoiding the remote-proxy session means no CLOUDFLARE_API_TOKEN is
// needed in the playwright process.
const proxy = await getPlatformProxy<{ DB?: D1Database }>({
  environment: 'test',
  remoteBindings: false,
});

const d1 = proxy.env.DB;
if (!d1) {
  throw new Error(
    "[e2e/db-client] D1 binding 'DB' missing from wrangler.jsonc [env.test]"
  );
}

export const testDb = drizzle(d1, { relations });

/**
 * No-op kept for backwards compatibility with callers that used to await an
 * init promise. The top-level await above already ran by the time anything
 * imports `ensureDbInit`.
 */
export const ensureDbInit = (): Promise<void> => Promise.resolve();

/**
 * Dispose the underlying getPlatformProxy / workerd process.
 * Should be called during global teardown.
 */
export async function disposeTestDb(): Promise<void> {
  try {
    await proxy.dispose();
  } catch {
    // Best effort
  }
}
