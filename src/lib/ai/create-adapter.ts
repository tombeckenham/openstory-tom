/**
 * Shared OpenRouter adapter factory
 * Creates TanStack AI adapters for OpenRouter models
 */

import { getEnv } from '#env';
import type { TextModel } from '@/lib/ai/models';
import {
  getOpenRouterApiKeyFromEnv,
  OpenRouterTextAdapter,
  openRouterText,
} from '@tanstack/ai-openrouter';

import { getLogger } from '@/lib/observability/logger';

const logger = getLogger(['openstory', 'ai', 'create-adapter']);

let loggedRetryMode = false;

type AdapterModel = Parameters<typeof openRouterText>[0];
type BaseAdapter = OpenRouterTextAdapter<AdapterModel>;

/**
 * @tanstack/ai-openrouter@0.13 (TanStack/ai PR #660) started copying chat()'s
 * root observability `metadata` onto the wire as OpenRouter's
 * `chatRequest.metadata`, which @openrouter/sdk validates as
 * Record<string, string>. Our metadata is structured (prompt ref object,
 * tags array, nested metadata object), so every call fails SDK input
 * validation before it leaves the process. Strip `metadata` from what the
 * adapter sees — the AI event bridge is fed by the chat() orchestrator's
 * event stream, not the adapter, so observability is unaffected. This
 * restores the 0.12 wire shape; if we ever want OpenRouter-side request
 * metadata, it belongs in `modelOptions.metadata` as plain strings.
 *
 * Reported upstream as https://github.com/TanStack/ai/issues/735 — remove
 * this wrapper once a fixed @tanstack/ai-openrouter ships.
 */
class WireSafeOpenRouterTextAdapter extends OpenRouterTextAdapter<AdapterModel> {
  override chatStream(options: Parameters<BaseAdapter['chatStream']>[0]) {
    return super.chatStream({ ...options, metadata: undefined });
  }

  override structuredOutput(
    options: Parameters<BaseAdapter['structuredOutput']>[0]
  ) {
    return super.structuredOutput({
      ...options,
      chatOptions: { ...options.chatOptions, metadata: undefined },
    });
  }

  override structuredOutputStream(
    options: Parameters<BaseAdapter['structuredOutputStream']>[0]
  ) {
    return super.structuredOutputStream({
      ...options,
      chatOptions: { ...options.chatOptions, metadata: undefined },
    });
  }
}

export function createAdapter(model: TextModel, apiKey?: string) {
  const env = getEnv();
  const key = apiKey ?? env.OPENROUTER_KEY;
  // Adapter type list lags behind OpenRouter's catalog — cast at the boundary
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Model is dynamic from config but always a valid OpenRouter model ID
  const adapterModel = model as Parameters<typeof openRouterText>[0];

  // During E2E recording, aimock proxies our OpenRouter calls upstream and
  // *buffers* the entire SSE response before relaying — see
  // node_modules/@copilotkit/aimock/dist/recorder.js. That buffering window
  // can trip the SDK's default backoff retry, producing two upstream calls
  // and two fixture files for the same prompt. Disable retry and stretch
  // the per-request timeout so the single proxied call has time to land.
  // QStash retries failed steps at the workflow layer, so this doesn't
  // remove all retry coverage — only the SDK-internal retry that fights
  // with aimock's buffering during record.
  const isRecording = env.E2E_RECORD === '1';

  if (!loggedRetryMode) {
    loggedRetryMode = true;
    logger.info(
      `retry=${isRecording ? 'disabled' : 'sdk-default'} timeout=${isRecording ? '600000ms' : 'sdk-default'} E2E_RECORD=${env.E2E_RECORD ?? '<unset>'}`
    );
  }

  const config = {
    httpReferer: env.VITE_APP_URL || 'http://localhost:3000',
    xTitle: env.VITE_APP_NAME || 'OpenStory',
    ...(env.OPENROUTER_BASE_URL && { serverURL: env.OPENROUTER_BASE_URL }),
    ...(isRecording && {
      retryConfig: { strategy: 'none' as const },
      timeoutMs: 600_000,
    }),
  };

  return new WireSafeOpenRouterTextAdapter(
    { apiKey: key || getOpenRouterApiKeyFromEnv(), ...config },
    adapterModel
  );
}
