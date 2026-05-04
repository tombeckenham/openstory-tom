/**
 * Snapshot DTO hashers for sequence-level workflows that opt into the snapshot
 * pattern (Stage 3: `mergeVideoWorkflow`).
 *
 * `compute*FromDto` helpers hash the inlined trigger-time payload; `*Current`
 * helpers re-resolve the upstream inputs from the live scoped DB so the
 * workflow can detect within-run divergence at write time.
 *
 * See docs/architecture/workflow-snapshots-and-content-hash-staleness.md
 * § "Stage 3: sequence-level video and music variants".
 */

import {
  computeSequenceVideoInputHash,
  type SequenceVideoFrameSource,
} from '@/lib/ai/input-hash';
import type { Frame } from '@/lib/db/schema';
import type { MergeVideoWorkflowInput } from '@/lib/workflow/types';

/**
 * Minimum scopedDb surface for `computeSequenceVideoHashCurrent`. Production
 * `ScopedDb` is a structural superset and assigns cleanly; tests can build
 * literal objects against this type without casting. Mirrors the narrowing
 * pattern in `image-workflow-snapshot.ts`.
 */
export type SequenceVideoHashScopedDb = {
  frames: {
    listBySequence: (
      sequenceId: string
    ) => Promise<
      Array<Pick<Frame, 'orderIndex' | 'videoUrl' | 'videoInputHash'>>
    >;
  };
};

function buildSourceList(
  videoUrls: readonly string[],
  hashes: readonly SequenceVideoFrameSource[] | undefined
): SequenceVideoFrameSource[] {
  // When the trigger site didn't inline `sourceFrameVideoHashes` (legacy
  // payloads, before this field existed), fall back to URL-keyed sources.
  // This preserves the previous hash for retry-idempotency at the cost of
  // missing within-run drift detection — acceptable for legacy chains.
  if (!hashes) {
    return videoUrls.map((url) => ({ kind: 'url', url }));
  }
  return [...hashes];
}

/**
 * Build the parallel `videoUrls` + `sourceFrameVideoHashes` lists for a
 * `MergeVideoWorkflowInput` payload from a list of frames. Frames without a
 * `videoUrl` are skipped (no playable source). Frames whose video has no
 * `videoInputHash` (legacy data) fall back to `{kind: 'url'}`.
 *
 * Caller is expected to pass frames already in playback order.
 */
export function buildMergeVideoSourcesFromFrames(
  frames: ReadonlyArray<
    Pick<Frame, 'orderIndex' | 'videoUrl' | 'videoInputHash'>
  >
): {
  videoUrls: string[];
  sourceFrameVideoHashes: SequenceVideoFrameSource[];
} {
  const videoUrls: string[] = [];
  const sourceFrameVideoHashes: SequenceVideoFrameSource[] = [];
  for (const f of frames) {
    if (!f.videoUrl) continue;
    videoUrls.push(f.videoUrl);
    sourceFrameVideoHashes.push(
      f.videoInputHash
        ? { kind: 'variantHash', hash: f.videoInputHash }
        : { kind: 'url', url: f.videoUrl }
    );
  }
  return { videoUrls, sourceFrameVideoHashes };
}

/**
 * Hash the merge-video workflow's inlined trigger-time payload. Pure — no DB.
 */
export function computeSequenceVideoHashFromDto(
  input: MergeVideoWorkflowInput
): Promise<string> {
  return computeSequenceVideoInputHash({
    sourceFrameVideos: buildSourceList(
      input.videoUrls,
      input.sourceFrameVideoHashes
    ),
    targetFps: input.targetFps ?? null,
    resolution: input.resolution ?? null,
  });
}

/**
 * Recompute the merge-video hash from live DB state. The merge inputs that can
 * drift between trigger and write are the upstream frame video `input_hash`es
 * — `targetFps` and `resolution` are workflow params that stay frozen on the
 * payload. We re-read each frame's current `videoInputHash` and rebuild the
 * source list in `videoUrls` order.
 *
 * When `sequenceId` is omitted (anonymous merges with no DB context), this
 * falls back to the FromDto hash so the workflow's existing short-circuits
 * handle the cleanup.
 *
 * Throws when a `videoUrls` entry no longer maps to any sequence frame
 * (raced delete). Falling back to `{kind: 'url'}` here would silently match
 * the trigger-time hash and route a stale merge onto the primary slot,
 * defeating the divergence check.
 */
export async function computeSequenceVideoHashCurrent(
  input: MergeVideoWorkflowInput,
  scopedDb: SequenceVideoHashScopedDb
): Promise<string> {
  if (!input.sequenceId) {
    return computeSequenceVideoHashFromDto(input);
  }

  const frames = await scopedDb.frames.listBySequence(input.sequenceId);
  const byUrl = new Map<string, string | null>();
  for (const f of frames) {
    if (f.videoUrl) {
      byUrl.set(f.videoUrl, f.videoInputHash);
    }
  }

  const currentSources: SequenceVideoFrameSource[] = input.videoUrls.map(
    (url) => {
      if (!byUrl.has(url)) {
        throw new Error(
          `[MergeVideo] Frame for url ${url} not found in sequence ${input.sequenceId} at write time — refusing to convergent-write a stale merge`
        );
      }
      const hash = byUrl.get(url);
      // Frame exists but has no input_hash (legacy data). The trigger-time
      // payload would also have been `{kind: 'url'}` for this frame, so
      // hashes still align cleanly on the convergent path.
      if (hash) {
        return { kind: 'variantHash', hash };
      }
      return { kind: 'url', url };
    }
  );

  return computeSequenceVideoInputHash({
    sourceFrameVideos: currentSources,
    targetFps: input.targetFps ?? null,
    resolution: input.resolution ?? null,
  });
}
