/**
 * AI Server Functions
 * End-to-end type-safe functions for AI operations
 */

import { getEnv } from '#env';
import {
  callLLM,
  callLLMStream,
  RECOMMENDED_MODELS,
} from '@/lib/ai/llm-client';
import { isValidAnalysisModelId } from '@/lib/ai/models.config';
import {
  checkForInjectionAttempts,
  sanitizeScriptContent,
} from '@/lib/ai/prompt-validation';
import {
  createUserPrompt,
  RateLimiter,
  scriptEnhancementRateLimiter,
} from '@/lib/ai/script-enhancer';
import { estimateLLMCost } from '@/lib/billing/cost-estimation';
import { aspectRatioSchema } from '@/lib/constants/aspect-ratios';
import { StyleConfigSchema } from '@/lib/db/schema/libraries';
import type { ScopedDb } from '@/lib/db/scoped';
import { InsufficientCreditsError } from '@/lib/errors';
import {
  getPrompt,
  type ChatMessage,
  type ChatMessageContentPart,
} from '@/lib/prompts';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { zodValidator } from '@tanstack/zod-adapter';
import { z } from 'zod';
import { authWithTeamMiddleware } from './middleware';

const promptShorteningRateLimiter = new RateLimiter(10, 60_000);

const SHORTEN_PROMPT_SYSTEM = `You are an expert at condensing image generation prompts while preserving all critical visual elements.

Your task is to shorten image prompts by:
- Removing verbose descriptions and redundant words
- Keeping essential visual elements: subjects, composition, style, lighting, mood
- Maintaining technical parameters (aspect ratio, quality, etc.)
- Preserving artistic style references and specific details
- Using concise, impactful language

Target 50-75% reduction in length while keeping the prompt's core meaning intact.

Return ONLY the shortened prompt text, nothing else. No explanations, no preamble.`;

function getClientIP(): string {
  const request = getRequest();
  return (
    request.headers.get('x-forwarded-for')?.split(',')[0] ||
    request.headers.get('x-real-ip') ||
    'anonymous'
  );
}

function enforceRateLimit(limiter: RateLimiter, key: string): void {
  if (limiter.isAllowed(key)) return;
  const remainingMs = limiter.getRemainingTime(key);
  throw new Error(
    `Rate limit exceeded. Please try again in ${Math.ceil(remainingMs / 1000)} seconds.`
  );
}

/**
 * Check pre-flight billing and return a deduct function.
 * Returns `undefined` when billing is skipped (disabled or team has own key).
 */
async function prepareBilling(
  scopedDb: ScopedDb,
  description: string,
  metadata?: Record<string, unknown>
): Promise<(() => Promise<void>) | undefined> {
  const teamHasOwnKey = await scopedDb.apiKeys.hasKey('openrouter');
  if (teamHasOwnKey) return undefined;

  const cost = estimateLLMCost(1);
  const canAfford = await scopedDb.billing.hasEnoughCredits(cost);
  if (!canAfford) {
    throw new InsufficientCreditsError(
      `Insufficient credits for ${description.toLowerCase()}`
    );
  }

  return async () => {
    if (cost > 0) {
      await scopedDb.billing.deductCredits(cost, {
        description,
        metadata,
      });
    }
  };
}

// -- Shorten Prompt --

const shortenPromptInputSchema = z.object({
  prompt: z
    .string()
    .min(20, 'Prompt must be at least 20 characters')
    .max(5000, 'Prompt too long'),
});

export const shortenPromptFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(shortenPromptInputSchema))
  .handler(async ({ data, context }) => {
    enforceRateLimit(promptShorteningRateLimiter, getClientIP());

    if (!getEnv().OPENROUTER_KEY) {
      throw new Error('AI service not configured');
    }

    const deduct = await prepareBilling(
      context.scopedDb,
      `Prompt shortening (${RECOMMENDED_MODELS.fast})`,
      { model: RECOMMENDED_MODELS.fast }
    );

    const shortenedPrompt = await callLLM({
      model: RECOMMENDED_MODELS.fast,
      messages: [
        { role: 'system' as const, content: SHORTEN_PROMPT_SYSTEM },
        { role: 'user' as const, content: data.prompt },
      ],
      max_tokens: 500,
      temperature: 0.3,
      observationName: 'shortenPrompt',
      userId: context.user.id,
    });

    await deduct?.();

    if (!shortenedPrompt) {
      throw new Error('No response received from AI service');
    }

    const trimmedPrompt = shortenedPrompt.trim();
    if (trimmedPrompt.length < 20) {
      throw new Error('Shortened prompt is too short. Please try again.');
    }

    return {
      originalPrompt: data.prompt,
      shortenedPrompt: trimmedPrompt,
      originalLength: data.prompt.length,
      shortenedLength: trimmedPrompt.length,
      reductionPercent: Math.round(
        ((data.prompt.length - trimmedPrompt.length) / data.prompt.length) * 100
      ),
    };
  });

// -- Enhance Script --

const enhanceScriptInputSchema = z.object({
  script: z
    .string()
    .min(10, 'Script must be at least 10 characters')
    .max(50000, 'Script too long'),
  targetDuration: z.number().min(5).max(180).optional(),
  tone: z.enum(['dramatic', 'comedic', 'documentary', 'action']).optional(),
  style: z.string().optional(),
  styleConfig: StyleConfigSchema.partial().optional(),
  analysisModel: z.string().optional(),
  aspectRatio: aspectRatioSchema.optional(),
  elements: z
    .array(
      z.object({
        token: z.string().min(1),
        description: z.string().nullable().optional(),
        imageUrl: z.string().url(),
      })
    )
    .optional(),
});

export const enhanceScriptStreamFn = createServerFn({ method: 'POST' })
  .middleware([authWithTeamMiddleware])
  .inputValidator(zodValidator(enhanceScriptInputSchema))
  .handler(async function* ({ data, context }) {
    enforceRateLimit(scriptEnhancementRateLimiter, getClientIP());

    const deduct = await prepareBilling(context.scopedDb, 'Script enhancement');

    if (checkForInjectionAttempts(data.script)) {
      console.warn('Script enhancement: Potential injection attempt detected');
    }

    const sanitized = sanitizeScriptContent(data.script);
    const { prompt, compiled } = await getPrompt('script/enhance');
    const elements = data.elements ?? [];
    const userPrompt = createUserPrompt(sanitized, {
      styleConfig: data.styleConfig,
      aspectRatio: data.aspectRatio,
      targetDuration: data.targetDuration,
      elements: elements.length > 0 ? elements : undefined,
    });

    const model =
      data.analysisModel && isValidAnalysisModelId(data.analysisModel)
        ? data.analysisModel
        : RECOMMENDED_MODELS.creative;

    const systemMessage = `${compiled}\n\nReturn ONLY the enhanced script text. No JSON, no markdown formatting, no explanations.`;

    const userContent: string | ChatMessageContentPart[] =
      elements.length > 0
        ? [
            { type: 'text', content: userPrompt },
            ...elements.map<ChatMessageContentPart>((el) => ({
              type: 'image',
              source: { type: 'url', value: el.imageUrl },
            })),
          ]
        : userPrompt;

    const messages: ChatMessage[] = [
      { role: 'system', content: systemMessage },
      { role: 'user', content: userContent },
    ];

    const promptRef = prompt
      ? {
          name: prompt.name,
          version: prompt.version,
          isFallback: false,
        }
      : undefined;

    // Disable web search during E2E recording: the plugin can cause the
    // model to emit tool_calls, which makes @tanstack/ai's agent loop
    // iterate a second time and produce a duplicate OpenRouter call per
    // logical enhance.
    const useWebSearchPlugin = getEnv().E2E_RECORD !== '1';
    for await (const chunk of callLLMStream({
      model,
      messages,
      max_tokens: 4000,
      temperature: 0.7,
      ...(useWebSearchPlugin && { plugins: [{ id: 'web' as const }] }),
      observationName: 'script-enhance',
      prompt: promptRef,
      tags: ['script-enhance', model],
      userId: context.user.id,
      metadata: {
        teamId: context.teamId,
        elementCount: elements.length,
        targetDuration: data.targetDuration,
        aspectRatio: data.aspectRatio,
      },
    })) {
      if (chunk.delta) {
        yield { delta: chunk.delta };
      }
    }

    await deduct?.();
  });
