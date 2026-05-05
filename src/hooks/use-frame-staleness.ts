import { getFrameStalenessFn } from '@/functions/frames';
import { useQuery } from '@tanstack/react-query';

export type FrameStaleness = {
  thumbnail: boolean;
  visualPrompt: boolean;
  motionPrompt: boolean;
};

export const frameStalenessKey = (frameId: string | undefined) =>
  ['frame-staleness', frameId] as const;

/**
 * Single source of truth for a frame's per-artifact staleness flags. Shared
 * by `<FrameStalenessBanners>` and the tab-label dot in
 * `<SceneScriptPrompts>` so both cache hits land on the same query.
 */
export function useFrameStaleness(args: {
  sequenceId: string;
  frameId: string | undefined;
}) {
  const { sequenceId, frameId } = args;
  return useQuery<FrameStaleness>({
    queryKey: frameStalenessKey(frameId),
    queryFn: () => {
      if (!frameId) throw new Error('frameId required');
      return getFrameStalenessFn({ data: { sequenceId, frameId } });
    },
    enabled: !!frameId,
    staleTime: 30_000,
  });
}
