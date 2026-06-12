import { resolveDebugOption } from '@tanstack/ai/adapter-internals';
import { OpenRouterTextAdapter } from '@tanstack/ai-openrouter';
import { describe, expect, it, vi } from 'vitest';

vi.doMock('#env', () => ({
  getEnv: () => ({
    OPENROUTER_KEY: 'test-key',
    VITE_APP_URL: 'http://localhost:3000',
    VITE_APP_NAME: 'OpenStory Test',
  }),
}));

const { createAdapter } = await import('./create-adapter');

/**
 * Regression tests for the @tanstack/ai-openrouter@0.13 wire-metadata leak
 * (TanStack/ai PR #660): the adapter copies chat()'s root observability
 * `metadata` into OpenRouter's `chatRequest.metadata`, which @openrouter/sdk
 * validates as Record<string, string> — our structured metadata fails that
 * validation and every LLM call dies client-side. createAdapter wraps the
 * adapter to strip `metadata` before it reaches the wire mapper.
 *
 * Lives apart from create-adapter.test.ts because these spies need the REAL
 * @tanstack/ai-openrouter prototype, which the routing tests mock out.
 */
describe('createAdapter wire-metadata stripping', () => {
  const observabilityMetadata = {
    observationName: 'test-call',
    prompt: { name: 'p', version: 1, isFallback: false },
    tags: ['a', 'b'],
    metadata: { nested: true },
    sessionId: 'seq_123',
  };

  const chatOptions = {
    model: 'anthropic/claude-sonnet-4.6',
    messages: [],
    systemPrompts: [],
    metadata: observabilityMetadata,
    logger: resolveDebugOption(false),
  };

  it('strips root metadata before chatStream hits the base adapter', () => {
    const spy = vi
      .spyOn(OpenRouterTextAdapter.prototype, 'chatStream')
      .mockReturnValue((async function* () {})());

    const adapter = createAdapter('anthropic/claude-sonnet-4.6');
    adapter.chatStream(chatOptions);

    expect(spy).toHaveBeenCalledTimes(1);
    const [firstCall] = spy.mock.calls;
    expect(firstCall?.[0].metadata).toBeUndefined();
    spy.mockRestore();
  });

  it('strips chatOptions metadata before structuredOutput hits the base adapter', async () => {
    const spy = vi
      .spyOn(OpenRouterTextAdapter.prototype, 'structuredOutput')
      .mockResolvedValue({ data: {}, rawText: '{}' });

    const adapter = createAdapter('anthropic/claude-sonnet-4.6');
    await adapter.structuredOutput({ chatOptions, outputSchema: {} });

    expect(spy).toHaveBeenCalledTimes(1);
    const [firstCall] = spy.mock.calls;
    expect(firstCall?.[0].chatOptions.metadata).toBeUndefined();
    spy.mockRestore();
  });

  it('strips chatOptions metadata before structuredOutputStream hits the base adapter', () => {
    const spy = vi
      .spyOn(OpenRouterTextAdapter.prototype, 'structuredOutputStream')
      .mockReturnValue((async function* () {})());

    const adapter = createAdapter('anthropic/claude-sonnet-4.6');
    adapter.structuredOutputStream({ chatOptions, outputSchema: {} });

    expect(spy).toHaveBeenCalledTimes(1);
    const [firstCall] = spy.mock.calls;
    expect(firstCall?.[0].chatOptions.metadata).toBeUndefined();
    spy.mockRestore();
  });
});
