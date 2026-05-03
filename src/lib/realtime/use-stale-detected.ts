import { frameKeys } from '@/hooks/use-frames';
import { useRealtime } from '@/lib/realtime/client';
import { useQueryClient } from '@tanstack/react-query';
import { useCallback, useRef } from 'react';
import { toast } from 'sonner';

const TOAST_DEBOUNCE_MS = 5_000;

type StaleDetectedEvent = {
  event: string;
  data: {
    entityType:
      | 'frame'
      | 'character'
      | 'location'
      | 'library-location'
      | 'talent';
    entityId: string;
    artifact?: 'thumbnail' | 'variant-image' | 'video' | 'audio' | 'sheet';
    snapshotInputHash: string;
    divergedVariantId?: string;
  };
};

type DebounceState = {
  count: number;
  timeout: ReturnType<typeof setTimeout> | null;
};

/**
 * Subscribes to `generation.stale:detected` for the current sequence channel.
 *
 * Two responsibilities:
 *  1. Show a sonner toast announcing the alternate. Debounced to one toast
 *     per sequence per 5s with a count, so a recast that lands many divergent
 *     variants in quick succession doesn't spam the user.
 *  2. Invalidate TanStack Query caches so the divergent banner / corner dot
 *     appear inline without a manual refresh.
 *
 * Returns nothing — this is a fire-and-forget subscription kept alive for the
 * scenes view's lifetime.
 */
export function useStaleDetected(sequenceId: string | undefined) {
  const queryClient = useQueryClient();
  const debounceRef = useRef<DebounceState>({ count: 0, timeout: null });

  const handleEvent = useCallback(
    (event: StaleDetectedEvent) => {
      if (event.event !== 'generation.stale:detected') return;
      if (!sequenceId) return;

      void queryClient.invalidateQueries({
        queryKey: frameKeys.list(sequenceId),
      });
      void queryClient.invalidateQueries({
        queryKey: frameKeys.divergentVariants(sequenceId),
      });

      const state = debounceRef.current;
      state.count += 1;
      if (state.timeout) return;
      state.timeout = setTimeout(() => {
        const count = state.count;
        state.count = 0;
        state.timeout = null;
        toast.info(
          count === 1
            ? 'An alternate version is available.'
            : `${count} alternate versions are available.`
        );
      }, TOAST_DEBOUNCE_MS);
    },
    [queryClient, sequenceId]
  );

  useRealtime({
    channels: sequenceId ? [sequenceId] : [],
    events: ['generation.stale:detected'] as const,
    onData: handleEvent,
    enabled: !!sequenceId,
  });
}
