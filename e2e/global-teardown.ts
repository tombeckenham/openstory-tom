import { stopAimockServer } from './mocks/aimock-server';

/**
 * Playwright global teardown - stops aimock after all tests complete.
 */
export default async function globalTeardown() {
  await stopAimockServer();
}
