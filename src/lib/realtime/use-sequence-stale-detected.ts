import { sequenceKeys } from '@/hooks/use-sequences';
import { sequenceVariantKeys } from '@/hooks/use-sequence-variants';
import { useRealtime } from '@/lib/realtime/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';

const TOAST_DEBOUNCE_MS = 5_000;

type SequenceStaleArtifact = 'merged-video' | 'music';

/**
 * Format the debounced "alternates available" toast for sequence-level
 * artifacts. Exported for unit testing.
 */
export function formatSequenceStaleToastMessage(
  count: number,
  artifact: SequenceStaleArtifact | 'mixed'
): string {
  const label =
    artifact === 'mixed'
      ? 'alternate'
      : artifact === 'merged-video'
        ? 'alternate merged video'
        : 'alternate music track';
  if (count === 1) {
    return `An ${label} is available.`;
  }
  return `${count} ${label}s are available.`;
}

type StaleDetectedEvent = {
  event: string;
  data: {
    entityType:
      | 'frame'
      | 'character'
      | 'location'
      | 'library-location'
      | 'talent'
      | 'sequence';
    entityId: string;
    artifact?:
      | 'thumbnail'
      | 'variant-image'
      | 'video'
      | 'audio'
      | 'sheet'
      | 'merged-video'
      | 'music';
    snapshotInputHash: string;
    divergedVariantId?: string;
  };
};

type DebounceState = {
  count: number;
  artifact: SequenceStaleArtifact | 'mixed' | null;
  timeout: ReturnType<typeof setTimeout> | null;
};

/**
 * Subscribes to `generation.stale:detected` filtered for sequence-scoped
 * artifacts (`merged-video`, `music`). Mirrors `useStaleDetected` for frames:
 *  1. Show a debounced sonner toast (5 s window, count + artifact label).
 *  2. Invalidate the matching `sequenceVariantKeys.divergent*` query so the
 *     inline banner appears without a manual refresh.
 */
export function useSequenceStaleDetected(sequenceId: string | undefined) {
  const queryClient = useQueryClient();
  const debounceRef = useRef<DebounceState>({
    count: 0,
    artifact: null,
    timeout: null,
  });

  const sequenceIdRef = useRef(sequenceId);
  useEffect(() => {
    sequenceIdRef.current = sequenceId;
  }, [sequenceId]);

  const handleEvent = useCallback(
    (event: StaleDetectedEvent) => {
      if (event.event !== 'generation.stale:detected') return;
      if (!sequenceId) return;
      if (event.data.entityType !== 'sequence') return;
      const artifact = event.data.artifact;
      if (artifact !== 'merged-video' && artifact !== 'music') return;
      const scheduledFor = sequenceId;

      void queryClient.invalidateQueries({
        queryKey:
          artifact === 'merged-video'
            ? sequenceVariantKeys.divergentVideo(sequenceId)
            : sequenceVariantKeys.divergentMusic(sequenceId),
      });
      void queryClient.invalidateQueries({
        queryKey: sequenceKeys.detail(sequenceId),
      });

      const state = debounceRef.current;
      state.count += 1;
      // Track the artifact label across debounced events. A single artifact
      // type stays specific; mixing video + music in the same window collapses
      // to the generic "alternate" label.
      state.artifact =
        state.artifact === null || state.artifact === artifact
          ? artifact
          : 'mixed';
      if (state.timeout) return;
      state.timeout = setTimeout(() => {
        const count = state.count;
        const summaryArtifact = state.artifact ?? 'merged-video';
        state.count = 0;
        state.artifact = null;
        state.timeout = null;
        if (scheduledFor !== sequenceIdRef.current) return;
        toast.info(formatSequenceStaleToastMessage(count, summaryArtifact));
      }, TOAST_DEBOUNCE_MS);
    },
    [queryClient, sequenceId]
  );

  const { status } = useRealtime({
    channels: sequenceId ? [sequenceId] : [],
    events: ['generation.stale:detected'] as const,
    onData: handleEvent,
    enabled: !!sequenceId,
  });

  // Surface realtime subscription failures so silent disconnects show up in
  // logs — without this the divergent banner can stay stale forever with no
  // signal. Polling fallback in `useSequenceDivergent*Variants` covers UX
  // recovery.
  useEffect(() => {
    if (!sequenceId) return;
    if (status === 'error') {
      console.error('[useSequenceStaleDetected] realtime channel error', {
        sequenceId,
      });
    }
  }, [status, sequenceId]);

  // Cancel any pending toast on unmount or sequence change so a navigation
  // within the 5 s debounce window doesn't fire a toast for a sequence the
  // user has already left.
  useEffect(() => {
    const state = debounceRef.current;
    return () => {
      if (state.timeout) {
        clearTimeout(state.timeout);
        state.timeout = null;
        state.count = 0;
        state.artifact = null;
      }
    };
  }, [sequenceId]);
}
