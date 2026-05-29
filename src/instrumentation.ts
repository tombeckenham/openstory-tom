/**
 * OpenTelemetry instrumentation boot.
 *
 * Imported as the very first statement of `src/server.ts` so the OTel tracer
 * provider and the @tanstack/ai event bridge are registered before any
 * TanStack Start routes, server functions, or middleware modules load.
 *
 * Both init functions are idempotent (guarded by module-local flags) so the
 * module is safe to load more than once per isolate.
 */

import { initAIEventBridge } from '@/lib/observability/ai-event-bridge';
import { initTracing } from '@/lib/observability/langfuse';
import { configureLogging } from '@/lib/observability/logger';

configureLogging();
initTracing();
initAIEventBridge();
