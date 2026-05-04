/**
 * Pure variant-resolution helpers for the merge-* workflow chain.
 *
 * Extracted so the data-corruption-vs-legitimate-skip decision tree can be
 * unit-tested without mounting a workflow runtime. Each helper accepts a
 * structural minimum of the scoped DB so tests can build literal stubs.
 */

import type {
  SequenceMusicVariant,
  SequenceVideoVariant,
} from '@/lib/db/schema';
import { WorkflowValidationError } from '@/lib/workflow/errors';

export type MergeVariantResolutionScopedDb = {
  sequence: (sequenceId: string) => {
    getMusicStatus: () => Promise<{
      musicStatus: 'pending' | 'generating' | 'completed' | 'failed' | null;
      musicUrl: string | null;
      musicModel: string | null;
    } | null>;
  };
  sequenceVariants: {
    getMusicPrimary: (
      sequenceId: string,
      model: string
    ) => Promise<SequenceMusicVariant | null>;
    getVideoPrimary: (
      sequenceId: string,
      workflow: string
    ) => Promise<SequenceVideoVariant | null>;
    getVideoById: (id: string) => Promise<SequenceVideoVariant | null>;
    getMusicById: (id: string) => Promise<SequenceMusicVariant | null>;
  };
};

/**
 * Resolve the music-variant id to mux against a freshly-merged video.
 * Returns `null` only when the sequence has no completed music — every other
 * branch (status=completed but musicUrl/musicModel missing, primary row
 * missing, primary status incomplete) is a data-corruption case and throws.
 */
export async function resolveMusicVariantForMux(
  scopedDb: MergeVariantResolutionScopedDb,
  sequenceId: string
): Promise<string | null> {
  const status = await scopedDb.sequence(sequenceId).getMusicStatus();

  // Legitimate skip: no music has completed for this sequence yet.
  if (status?.musicStatus !== 'completed') {
    return null;
  }

  // status=completed should always mean musicUrl + musicModel are set; if
  // not, the sequences row is inconsistent — fail loudly instead of
  // silently shipping a soundless video.
  if (!status.musicUrl || !status.musicModel) {
    throw new Error(
      `[MergeVideo] Sequence ${sequenceId} musicStatus=completed but musicUrl/musicModel missing — sequences row is inconsistent`
    );
  }

  const primary = await scopedDb.sequenceVariants.getMusicPrimary(
    sequenceId,
    status.musicModel
  );
  if (!primary) {
    throw new Error(
      `[MergeVideo] Sequence ${sequenceId} music model=${status.musicModel} is completed on sequences.* but no matching sequence_music_variants primary row exists`
    );
  }
  if (primary.status !== 'completed' || !primary.url) {
    throw new Error(
      `[MergeVideo] Music variant ${primary.id} for sequence ${sequenceId} is status=${primary.status} url=${primary.url ? 'present' : 'null'} — refusing to mux`
    );
  }
  return primary.id;
}

/**
 * Resolve the merged-video and music variant ids to their stored URLs for
 * the audio-video mux step. Throws `WorkflowValidationError` on any missing
 * row or missing URL — both indicate a stale or invalid input from the
 * caller (motion-batch resolved variants that don't exist anymore).
 */
export async function resolveMergeAudioVideoSourceUrls(
  scopedDb: MergeVariantResolutionScopedDb,
  mergedVideoVariantId: string,
  musicVariantId: string
): Promise<{ mergedVideoUrl: string; musicUrl: string }> {
  const [videoVariant, musicVariant] = await Promise.all([
    scopedDb.sequenceVariants.getVideoById(mergedVideoVariantId),
    scopedDb.sequenceVariants.getMusicById(musicVariantId),
  ]);
  if (!videoVariant || !videoVariant.url) {
    throw new WorkflowValidationError(
      `Merged video variant ${mergedVideoVariantId} not found or missing url`
    );
  }
  if (!musicVariant || !musicVariant.url) {
    throw new WorkflowValidationError(
      `Music variant ${musicVariantId} not found or missing url`
    );
  }
  return { mergedVideoUrl: videoVariant.url, musicUrl: musicVariant.url };
}

/**
 * Resolve the merged-video and music variant ids that motion-batch hands to
 * `merge-audio-video`. Pulls the music model from `sequences.musicModel` (the
 * source of truth for "which model was used") and throws when either primary
 * row is missing or incomplete.
 */
export async function resolveMotionBatchMergeMusicVariants(
  scopedDb: MergeVariantResolutionScopedDb,
  sequenceId: string,
  videoWorkflow: string
): Promise<{ mergedVideoVariantId: string; musicVariantId: string }> {
  const seq = scopedDb.sequence(sequenceId);
  const musicStatus = await seq.getMusicStatus();

  if (!musicStatus?.musicModel) {
    throw new Error('Music generation completed but no model recorded');
  }

  const [videoVariant, musicVariant] = await Promise.all([
    scopedDb.sequenceVariants.getVideoPrimary(sequenceId, videoWorkflow),
    scopedDb.sequenceVariants.getMusicPrimary(
      sequenceId,
      musicStatus.musicModel
    ),
  ]);
  if (!videoVariant || videoVariant.status !== 'completed') {
    throw new Error(
      'Merged video primary variant not found for completed merge'
    );
  }
  if (!musicVariant || musicVariant.status !== 'completed') {
    throw new Error(
      'Music primary variant not found for completed music generation'
    );
  }

  return {
    mergedVideoVariantId: videoVariant.id,
    musicVariantId: musicVariant.id,
  };
}
