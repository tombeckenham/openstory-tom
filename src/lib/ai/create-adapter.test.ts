/**
 * Adapter-factory routing tests (issue #895). Pins the load-bearing wire
 * behavior nothing else covers: which endpoint a key routes to, the
 * `Authorization: Key` rewrite fal requires (its OpenRouter endpoint rejects
 * the SDK's hardcoded `Bearer` with 401), aimock's OPENROUTER_BASE_URL
 * precedence for e2e hermeticity, and the platform-key fallback order.
 */

import type { HTTPClient } from '@openrouter/sdk/lib/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mutable so individual tests can vary platform keys (reset in beforeEach).
const testEnv: {
  OPENROUTER_KEY: string | undefined;
  FAL_KEY: string | undefined;
  OPENROUTER_BASE_URL: string | undefined;
  E2E_RECORD: string | undefined;
  VITE_APP_URL: string;
  VITE_APP_NAME: string;
} = {
  OPENROUTER_KEY: undefined,
  FAL_KEY: undefined,
  OPENROUTER_BASE_URL: undefined,
  E2E_RECORD: undefined,
  VITE_APP_URL: 'http://localhost:3000',
  VITE_APP_NAME: 'OpenStory',
};

vi.doMock('#env', () => ({
  getEnv: () => testEnv,
}));

type AdapterConfig = {
  httpReferer: string;
  xTitle: string;
  serverURL?: string;
  httpClient?: HTTPClient;
};

// Capture (model, key, config) instead of building real adapters. The real
// HTTPClient stays unmocked so the beforeRequest hook is exercised for real.
const createOpenRouterTextMock = vi.fn(
  (_model: string, _key: string, _config: AdapterConfig) => 'adapter-with-key'
);
const openRouterTextMock = vi.fn(
  (_model: string, _config: AdapterConfig) => 'adapter-keyless'
);
vi.doMock('@tanstack/ai-openrouter', () => ({
  createOpenRouterText: createOpenRouterTextMock,
  openRouterText: openRouterTextMock,
}));

// Dynamic import so the mocks above apply — see CLAUDE.md module-mocking
// pattern.
const { createAdapter, getPlatformLlmKey } = await import('./create-adapter');

const MODEL = 'x-ai/grok-4.3';
const FAL_URL = 'https://fal.run/openrouter/router/openai/v1';

function lastKeyedCall(): {
  model: string;
  key: string;
  config: AdapterConfig;
} {
  const call = createOpenRouterTextMock.mock.calls.at(-1);
  if (!call) throw new Error('createOpenRouterText was not called');
  return { model: call[0], key: call[1], config: call[2] };
}

/**
 * Push a request through the adapter's HTTPClient and return what would hit
 * the wire, so tests assert on the post-hook Authorization header.
 */
async function sendThroughClient(
  client: HTTPClient,
  headers: Record<string, string>
): Promise<Request> {
  let sent: Request | undefined;
  vi.stubGlobal(
    'fetch',
    async (input: RequestInfo | URL): Promise<Response> => {
      if (input instanceof Request) sent = input;
      return new Response('{}');
    }
  );
  await client.request(new Request('https://example.test/v1', { headers }));
  if (!sent) throw new Error('HTTPClient never reached fetch');
  return sent;
}

beforeEach(() => {
  testEnv.OPENROUTER_KEY = undefined;
  testEnv.FAL_KEY = undefined;
  testEnv.OPENROUTER_BASE_URL = undefined;
  testEnv.E2E_RECORD = undefined;
  createOpenRouterTextMock.mockClear();
  openRouterTextMock.mockClear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createAdapter routing (issue #895)', () => {
  it('routes via:"fal" to fal’s OpenRouter endpoint and rewrites auth to "Key"', async () => {
    createAdapter(MODEL, { key: 'sk-fal-team', via: 'fal' });

    const { key, config } = lastKeyedCall();
    expect(key).toBe('sk-fal-team');
    expect(config.serverURL).toBe(FAL_URL);
    if (!config.httpClient) throw new Error('expected an httpClient');

    // The SDK hardcodes `Bearer`; fal’s endpoint 401s on it. The hook must
    // overwrite whatever Authorization the SDK set, as the last writer.
    const sent = await sendThroughClient(config.httpClient, {
      Authorization: 'Bearer sdk-set-this',
    });
    expect(sent.headers.get('Authorization')).toBe('Key sk-fal-team');
  });

  it('routes via:"openrouter" directly: no serverURL override, no auth hook', () => {
    createAdapter(MODEL, { key: 'sk-or-team', via: 'openrouter' });

    const { key, config } = lastKeyedCall();
    expect(key).toBe('sk-or-team');
    expect(config.serverURL).toBeUndefined();
    expect(config.httpClient).toBeUndefined();
  });

  it('treats a bare string key as an OpenRouter key (legacy overload)', () => {
    createAdapter(MODEL, 'sk-or-legacy');

    const { key, config } = lastKeyedCall();
    expect(key).toBe('sk-or-legacy');
    expect(config.serverURL).toBeUndefined();
    expect(config.httpClient).toBeUndefined();
  });

  it('lets OPENROUTER_BASE_URL (aimock) win over the fal proxy URL', () => {
    testEnv.OPENROUTER_BASE_URL = 'http://localhost:4010/v1';
    createAdapter(MODEL, { key: 'sk-fal-team', via: 'fal' });

    // E2E stays hermetic regardless of which key the team resolved.
    expect(lastKeyedCall().config.serverURL).toBe('http://localhost:4010/v1');
  });

  it('falls back to the platform OpenRouter key when no keyInfo is passed', () => {
    testEnv.OPENROUTER_KEY = 'platform-or';
    testEnv.FAL_KEY = 'platform-fal';
    createAdapter(MODEL);

    const { key, config } = lastKeyedCall();
    expect(key).toBe('platform-or');
    expect(config.serverURL).toBeUndefined();
  });

  it('falls back to the platform fal key (fal-routed) when only FAL_KEY is set', async () => {
    testEnv.FAL_KEY = 'platform-fal';
    createAdapter(MODEL);

    const { key, config } = lastKeyedCall();
    expect(key).toBe('platform-fal');
    expect(config.serverURL).toBe(FAL_URL);
    if (!config.httpClient) throw new Error('expected an httpClient');
    const sent = await sendThroughClient(config.httpClient, {
      Authorization: 'Bearer sdk-set-this',
    });
    expect(sent.headers.get('Authorization')).toBe('Key platform-fal');
  });

  it('builds a keyless adapter when nothing is configured', () => {
    createAdapter(MODEL);

    expect(createOpenRouterTextMock).not.toHaveBeenCalled();
    expect(openRouterTextMock).toHaveBeenCalledTimes(1);
  });
});

describe('getPlatformLlmKey', () => {
  it('prefers OPENROUTER_KEY over FAL_KEY', () => {
    testEnv.OPENROUTER_KEY = 'platform-or';
    testEnv.FAL_KEY = 'platform-fal';
    expect(getPlatformLlmKey()).toStrictEqual({
      key: 'platform-or',
      via: 'openrouter',
      source: 'platform',
    });
  });

  it('routes through fal with only FAL_KEY set', () => {
    testEnv.FAL_KEY = 'platform-fal';
    expect(getPlatformLlmKey()).toStrictEqual({
      key: 'platform-fal',
      via: 'fal',
      source: 'platform',
    });
  });

  it('returns undefined when neither key is configured', () => {
    expect(getPlatformLlmKey()).toBeUndefined();
  });
});
