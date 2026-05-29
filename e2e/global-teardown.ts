import { stopAimockServer } from './mocks/aimock-server';
import { stopR2MockServer } from './mocks/r2-mock-server';
import { disposeTestDb } from './fixtures/db-client';

/**
 * Playwright global teardown - stops aimock + r2-mock after all tests complete.
 *
 * Also disposes the getPlatformProxy used by direct DB fixtures (testDb).
 * Note: each Playwright worker process creates its own proxy instance
 * (see e2e/fixtures/db-client.ts for the multi-process risk discussion).
 */
export default async function globalTeardown() {
  await stopAimockServer();
  await stopR2MockServer();
  await disposeTestDb();
}
