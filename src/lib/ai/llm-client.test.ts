import { beforeEach, describe, expect, it, mock } from 'bun:test';

// Import real exports before mock.module so they can be re-exported
import * as tanstackAi from '@tanstack/ai';

// Mock environment
mock.module('#env', () => ({
  getEnv: () => ({
    OPENROUTER_KEY: 'test-key',
    VITE_APP_URL: 'http://localhost:3000',
    VITE_APP_NAME: 'Test',
  }),
}));

// Mock @tanstack/ai — chat() is the only function callLLMStream uses
// Re-export all real exports so other test files aren't affected by incomplete mock
const mockChat = mock();
mock.module('@tanstack/ai', () => ({
  ...tanstackAi,
  chat: mockChat,
}));

// Mock create-adapter to avoid real adapter creation
mock.module('./create-adapter', () => ({
  createAdapter: () => ({ kind: 'text', name: 'mock' }),
}));

import { callLLMStream } from './llm-client';

describe('llm-client', () => {
  beforeEach(() => {
    mockChat.mockClear();
  });

  describe('callLLMStream', () => {
    it('handles split chunks correctly', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'Hello' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: ' ' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'World' };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      let fullText = '';
      const chunks = [];

      for await (const chunk of generator) {
        if (!chunk.done) {
          fullText = chunk.accumulated;
          chunks.push(chunk.delta);
        }
      }

      expect(fullText).toBe('Hello World');
      expect(chunks).toEqual(['Hello', ' ', 'World']);
    });

    it('handles multiple lines in a single chunk', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'A' };
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'B' };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      let fullText = '';
      const chunks = [];

      for await (const chunk of generator) {
        if (!chunk.done) {
          fullText = chunk.accumulated;
          chunks.push(chunk.delta);
        }
      }

      expect(fullText).toBe('AB');
      expect(chunks).toEqual(['A', 'B']);
    });

    it('forwards userId and sessionId to chat metadata', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'ok' };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
        userId: 'user-123',
        sessionId: 'seq-456',
        observationName: 'unit-test',
      });

      for await (const _chunk of generator) {
        // drain
      }

      expect(mockChat).toHaveBeenCalledTimes(1);
      const callArgs = mockChat.mock.calls[0][0];
      expect(callArgs.metadata).toMatchObject({
        userId: 'user-123',
        sessionId: 'seq-456',
        observationName: 'unit-test',
      });
    });

    it('handles stream errors', async () => {
      mockChat.mockReturnValue(
        (async function* () {
          yield { type: 'TEXT_MESSAGE_CONTENT', delta: 'partial' };
          yield {
            type: 'RUN_ERROR',
            message: 'Connection lost',
          };
        })()
      );

      const generator = callLLMStream({
        model: 'anthropic/claude-sonnet-4.6',
        messages: [{ role: 'user', content: 'test' }],
      });

      expect(async () => {
        for await (const _chunk of generator) {
          // iterate until error
        }
      }).toThrow('LLM stream error: Connection lost');
    });
  });
});
