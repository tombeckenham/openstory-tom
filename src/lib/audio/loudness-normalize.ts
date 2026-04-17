/**
 * Loudness Normalization Service
 * Normalizes an audio track to a target integrated loudness (LUFS) using
 * fal.ai's EBU R128 loudnorm endpoint. Used to duck background music so it
 * sits consistently below dialogue in the final video mix.
 */

import { createFalClient } from '@fal-ai/client';
import { getEnv } from '#env';
import type { ScopedDb } from '@/lib/db/scoped';

const LOUDNORM_MODEL_ID = 'fal-ai/ffmpeg-api/loudnorm';

/**
 * Target integrated loudness for background music (LUFS).
 * Generated music typically outputs at -14 to -18 LUFS; dialogue in video output
 * lands in a similar range. Targeting -24 LUFS puts the music bed ~6-10 LU
 * below voice — audible but comfortably underneath, the standard broadcast
 * offset for music-under-dialogue.
 */
export const DEFAULT_MUSIC_LOUDNESS_LUFS = -24;

export type LoudnessNormalizeResult = {
  audioUrl: string;
  requestId?: string;
  usedOwnKey: boolean;
};

function hasKey<K extends string>(
  obj: object,
  key: K
): obj is Record<K, unknown> {
  return key in obj;
}

function extractAudioUrl(data: unknown): string | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  for (const key of ['audio', 'audio_file'] as const) {
    if (!hasKey(data, key)) continue;
    const field = data[key];
    if (typeof field === 'string') return field;
    if (typeof field === 'object' && field !== null && hasKey(field, 'url')) {
      if (typeof field.url === 'string') return field.url;
    }
  }
  return undefined;
}

/**
 * Normalize an audio file to a target integrated loudness.
 * Uses two-pass (dynamic) mode for better quality.
 */
export async function normalizeAudioLoudness({
  audioUrl,
  integratedLoudness = DEFAULT_MUSIC_LOUDNESS_LUFS,
  scopedDb,
}: {
  audioUrl: string;
  /** Target integrated loudness in LUFS. Defaults to -30 LUFS (quiet background). */
  integratedLoudness?: number;
  scopedDb?: ScopedDb;
}): Promise<LoudnessNormalizeResult> {
  console.log('[LoudnessNormalize] Normalizing audio', {
    audioUrl: audioUrl.slice(0, 80),
    integratedLoudness,
  });

  const falApiKeyInfo = scopedDb
    ? await scopedDb.apiKeys.resolveKey('fal')
    : { key: getEnv().FAL_KEY, source: 'platform' as const };
  const fal = createFalClient({ credentials: falApiKeyInfo.key });

  let requestId: string | undefined;

  const result = await fal.subscribe(LOUDNORM_MODEL_ID, {
    input: {
      audio_url: audioUrl,
      integrated_loudness: integratedLoudness,
    },
    logs: true,
    pollInterval: 5000,
    onEnqueue: (reqId: string) => {
      requestId = reqId;
      console.log(`[LoudnessNormalize] Request enqueued: ${reqId}`);
    },
  });

  const outputUrl = extractAudioUrl(result.data);
  if (!outputUrl) {
    throw new Error('No audio URL returned from loudness normalization');
  }

  return {
    audioUrl: outputUrl,
    requestId: requestId ?? result.requestId,
    usedOwnKey: falApiKeyInfo.source === 'team',
  };
}
