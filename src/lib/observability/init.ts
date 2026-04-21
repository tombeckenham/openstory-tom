/**
 * Side-effect boot module for tracing.
 * Importing this file once per isolate wires up the OTel tracer provider
 * (Langfuse + PostHog exporters) and the @tanstack/ai event bridge so that
 * chat() calls emit gen_ai spans.
 *
 * Both init functions are idempotent — importing this from multiple entry
 * points (server-function middleware, workflow routes) is safe.
 */

import { initAIEventBridge } from './ai-event-bridge';
import { initTracing } from './langfuse';

initTracing();
initAIEventBridge();
