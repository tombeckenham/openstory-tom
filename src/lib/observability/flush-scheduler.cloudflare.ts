/**
 * Cloudflare Workers implementation: schedules the flush via
 * `cloudflare:workers` `waitUntil()` so it runs after the response is sent
 * instead of blocking the user-visible request duration.
 *
 * See issue #770 / PR #765: previously every serverFn awaited
 * `flushTracing()` synchronously in `tracingMiddleware`, which added
 * 100-500 ms (one Langfuse OTLP POST) to every request's wall-clock time.
 */

import { waitUntil } from 'cloudflare:workers';
import { flushTracing } from './langfuse';
import { getLogger } from './logger';

const logger = getLogger(['openstory', 'observability', 'flush-scheduler']);

export async function scheduleFlushTracing(): Promise<void> {
  // `waitUntil` keeps the isolate alive until the promise resolves but does
  // not block the response. If the flush throws, swallow + log so we don't
  // surface tracing failures to the user.
  waitUntil(
    flushTracing().catch((err: unknown) => {
      logger.error('background flushTracing failed', { err });
    })
  );
}
