/**
 * Default (non-Workers) implementation: awaits the flush inline. Used in
 * tests and local SSR where there's no Cloudflare execution context to defer
 * the work to.
 */

import { flushTracing } from './langfuse';

export async function scheduleFlushTracing(): Promise<void> {
  await flushTracing();
}
