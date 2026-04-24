import { getEnv } from '#env';
import { calculateAudioCost } from '@/lib/ai/fal-cost';
import { extractFalErrorMessage } from '@/lib/ai/fal-error';
import {
  AUDIO_MODEL_KEYS,
  AUDIO_MODELS,
  DEFAULT_MUSIC_MODEL,
  type AudioModel,
  type AudioModelConfig,
} from '@/lib/ai/models';
import { microsToUsd, type Microdollars } from '@/lib/billing/money';
import type { ScopedDb } from '@/lib/db/scoped';
import {
  endSpanError,
  endSpanSuccess,
  startGenAISpan,
} from '@/lib/observability/tracer';
import { generateAudio } from '@tanstack/ai';
import { falAudio } from '@tanstack/ai-fal';
import { z } from 'zod';

export const generateMusicOptionsSchema = z.object({
  prompt: z.string().min(1),
  tags: z.string().optional(),
  lyrics: z.string().optional(),
  duration: z.number().min(1).max(240).optional(),
  instrumental: z.boolean().optional().default(true),
  model: z.enum(AUDIO_MODEL_KEYS).optional().default(DEFAULT_MUSIC_MODEL),
  steps: z.number().optional(),
});

export type GenerateMusicOptions = {
  scopedDb?: ScopedDb;
  /** Style/mood prompt for the music (e.g., "tense orchestral, dark atmosphere") */
  prompt: string;
  /** Comma-separated genre tags (e.g., "orchestral, ambient, cinematic") */
  tags?: string;
  /** Lyrics with [verse], [chorus], [bridge] structure. Use [inst] for instrumental. */
  lyrics?: string;
  /** Duration in seconds (1-240, default: 60) */
  duration?: number;
  /** Generate instrumental only (default: true) */
  instrumental?: boolean;
  model?: AudioModel;
  /** Number of diffusion steps (default: 27) */
  steps?: number;
  traceName?: string;
};

export type MusicResult = {
  success: boolean;
  audioUrl?: string;
  metadata: {
    model: string;
    provider: string;
    duration: number;
    cost: Microdollars;
    generatedAt: string;
    usedOwnKey: boolean;
  };
  error?: string;
  requestId?: string;
};

function clampDuration(
  requested: number | undefined,
  config: AudioModelConfig
): number {
  if (!requested) return config.capabilities.defaultDuration;
  return Math.min(requested, config.capabilities.maxDuration);
}

type AudioCallShape = {
  prompt: string;
  modelOptions: Record<string, unknown>;
};

type AudioCallBuilder = (
  options: GenerateMusicOptions,
  config: AudioModelConfig
) => AudioCallShape;

/**
 * Per-model builders that turn `GenerateMusicOptions` into the shape required
 * by `generateAudio`. The `falAudio` adapter handles `prompt` and `duration`
 * (mapping the latter to `music_length_ms` for ElevenLabs Music), so we only
 * forward model-specific parameters via `modelOptions`.
 */
const AUDIO_CALL_BUILDERS: Partial<Record<AudioModel, AudioCallBuilder>> = {
  ace_step: (options) => {
    const lyrics =
      options.instrumental && !options.lyrics
        ? '[inst]'
        : (options.lyrics ?? '[inst]');

    return {
      prompt: options.tags ?? options.prompt,
      modelOptions: {
        lyrics,
        instrumental: options.instrumental ?? true,
        number_of_steps: options.steps ?? 27,
        scheduler: 'euler',
        guidance_type: 'apg',
      },
    };
  },

  elevenlabs_music: (options) => ({
    prompt: options.prompt,
    modelOptions: {
      force_instrumental: options.instrumental ?? true,
    },
  }),

  minimax_music_v2: (options) => ({
    prompt: options.prompt,
    modelOptions: {},
  }),

  lyria_2: (options) => ({
    prompt: options.prompt,
    modelOptions: {},
  }),
};

/**
 * Generate music/audio via TanStack AI's `generateAudio` activity using the
 * `falAudio` adapter.
 */
export async function generateMusic(
  options: GenerateMusicOptions
): Promise<MusicResult> {
  const modelKey = options.model || DEFAULT_MUSIC_MODEL;
  const modelConfig = AUDIO_MODELS[modelKey];

  const span = startGenAISpan(options.traceName ?? 'fal-music', {
    model: modelKey,
    provider: 'fal',
    operation: 'generate_content',
    input: {
      prompt: options.prompt,
      tags: options.tags,
      duration: options.duration,
      instrumental: options.instrumental,
    },
  });

  try {
    const result = await callFalAudio(options, modelConfig);

    if (result.metadata.cost) {
      span.setAttribute('gen_ai.usage.cost', microsToUsd(result.metadata.cost));
    }
    endSpanSuccess(span, { audioUrl: result.audioUrl });

    return result;
  } catch (error) {
    endSpanError(span, extractFalErrorMessage(error));
    throw error;
  }
}

async function callFalAudio(
  options: GenerateMusicOptions,
  modelConfig: AudioModelConfig
): Promise<MusicResult> {
  const modelKey = options.model || DEFAULT_MUSIC_MODEL;
  const builder = AUDIO_CALL_BUILDERS[modelKey];
  if (!builder) {
    throw new Error(`No audio call builder for model: ${modelKey}`);
  }

  const { prompt, modelOptions } = builder(options, modelConfig);
  const duration = clampDuration(options.duration, modelConfig);

  console.log(
    `[Music Service] Generating music with model: ${modelConfig.id}`,
    {
      provider: modelConfig.provider,
      promptLength: prompt.length,
      duration,
    }
  );

  const falApiKeyInfo = options.scopedDb
    ? await options.scopedDb.apiKeys.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };

  const adapter = falAudio(modelConfig.id, { apiKey: falApiKeyInfo.key });
  const result = await generateAudio({
    adapter,
    prompt,
    duration,
    modelOptions,
  });

  if (!result.audio.url) {
    console.error('[Music Service] No audio URL in result:', result);
    throw new Error('No audio URL returned from music generation');
  }

  const cost = calculateAudioCost({
    endpointId: modelConfig.id,
    durationSeconds: duration,
  });

  return {
    success: true,
    audioUrl: result.audio.url,
    requestId: result.id,
    metadata: {
      model: modelConfig.id,
      provider: modelConfig.provider,
      duration,
      cost,
      generatedAt: new Date().toISOString(),
      usedOwnKey: falApiKeyInfo.source === 'team',
    },
  };
}
