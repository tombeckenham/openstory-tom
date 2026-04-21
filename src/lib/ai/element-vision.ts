/**
 * Element Vision Helper
 *
 * Describes an uploaded element image using a vision-capable LLM via
 * @tanstack/ai's OpenRouter adapter.
 */

import type { ChatMessage } from '@/lib/prompts';
import { chat } from '@tanstack/ai';
import { z } from 'zod';
import { createAdapter } from './create-adapter';

const VISION_MODEL = 'anthropic/claude-sonnet-4.6';

const responseSchema = z.object({
  description: z.string().min(1),
  consistencyTag: z.string().min(1),
});

export type ElementDescription = z.infer<typeof responseSchema>;

export type DescribeElementInput = {
  imageUrl: string;
  filename: string;
  token: string;
  /** Override OpenRouter API key (team-provided) */
  openRouterApiKey?: string;
};

/**
 * Build the multimodal chat messages for the vision LLM.
 * Exported for testing.
 */
export function buildVisionMessages(
  token: string,
  filename: string,
  imageUrl: string
): ChatMessage[] {
  const system = `You are a visual reference describer. You will be shown a single image that will serve as a canonical reference for an element (logo, product, screenshot, or similar object) in a film/video production. Your job is to describe what the image visually contains so that AI image generators can later reproduce the element faithfully across scenes.

Your output MUST be strict JSON with two fields:
- "description": 60-120 words. Describe shape, proportions, colors, text rendered on the element (verbatim), finish/material, any distinguishing marks, and how it is oriented. Do NOT describe background, lighting, camera angle, or the overall photograph — only the element itself.
- "consistencyTag": A lowercase slug (3-6 words joined by hyphens) capturing the element's visual identity for reuse in prompts (e.g. "red-hex-brand-logo", "silver-metal-water-bottle").

Return ONLY the JSON object. No prose, no markdown fences.`;

  const userText = `Element token: ${token}
Uploaded filename: ${filename}

Describe the element in the image below.`;

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: [
        { type: 'text', content: userText },
        { type: 'image', source: { type: 'url', value: imageUrl } },
      ],
    },
  ];
}

export async function describeElementImage(
  input: DescribeElementInput
): Promise<ElementDescription> {
  const messages = buildVisionMessages(
    input.token,
    input.filename,
    input.imageUrl
  );

  const systemPrompts: string[] = [];
  const chatMessages: Array<{
    role: 'user' | 'assistant';
    content: ChatMessage['content'];
  }> = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      if (typeof msg.content === 'string') systemPrompts.push(msg.content);
    } else {
      chatMessages.push({ role: msg.role, content: msg.content });
    }
  }

  const adapter = createAdapter(VISION_MODEL, input.openRouterApiKey);

  const result = await chat({
    adapter,
    systemPrompts,
    messages: chatMessages,
    stream: false,
    temperature: 0.3,
    outputSchema: responseSchema,
  });

  return responseSchema.parse(result);
}
