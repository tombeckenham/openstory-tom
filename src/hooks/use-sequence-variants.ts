import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  discardSequenceMusicVariantFn,
  discardSequenceVideoVariantFn,
  getDivergentSequenceMusicVariantsFn,
  getDivergentSequenceVideoVariantsFn,
  getTeamDivergentSequenceVariantsFn,
  promoteSequenceMusicVariantFn,
  promoteSequenceVideoVariantFn,
  undiscardSequenceMusicVariantFn,
  undiscardSequenceVideoVariantFn,
} from '@/functions/sequence-variants';
import { sequenceKeys } from '@/hooks/use-sequences';
import type {
  SequenceMusicVariant,
  SequenceVideoVariant,
} from '@/lib/db/schema';
import type { Sequence } from '@/types/database';

/**
 * Query-key factory for sequence-level variants. The strings here match the
 * ones the realtime `query-cache-updater` invalidates on
 * `generation.stale:detected` events with `entityType: 'sequence'`.
 */
export const sequenceVariantKeys = {
  all: ['sequence-variants'] as const,
  divergentVideo: (sequenceId: string) =>
    ['sequence-divergent-video', sequenceId] as const,
  divergentMusic: (sequenceId: string) =>
    ['sequence-divergent-music', sequenceId] as const,
  divergentByTeam: (teamId?: string) =>
    ['sequence-divergent-by-team', teamId ?? null] as const,
};

// ── Read hooks ─────────────────────────────────────────────────────────────

/**
 * Live divergent merged-video alternates for a sequence (not discarded).
 * The corner-dot indicator and inline banner both consume this list.
 */
export function useSequenceDivergentVideoVariants(
  sequenceId?: string,
  options?: { refetchInterval?: number | false }
) {
  return useQuery<SequenceVideoVariant[]>({
    queryKey: sequenceVariantKeys.divergentVideo(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getDivergentSequenceVideoVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

export function useSequenceDivergentMusicVariants(
  sequenceId?: string,
  options?: { refetchInterval?: number | false }
) {
  return useQuery<SequenceMusicVariant[]>({
    queryKey: sequenceVariantKeys.divergentMusic(sequenceId ?? ''),
    queryFn: async () => {
      if (!sequenceId) throw new Error('sequenceId is required');
      return getDivergentSequenceMusicVariantsFn({ data: { sequenceId } });
    },
    enabled: !!sequenceId,
    staleTime: 30_000,
    refetchInterval: options?.refetchInterval ?? false,
  });
}

/**
 * Aggregate read for the team's sequences-list dashboard. Returns one row per
 * sequence that has at least one live divergent alternate, with separate
 * flags for video vs music. The `enabled` arg should be true once the team
 * dashboard has loaded; the server function uses the user's default team.
 */
export function useTeamDivergentSequenceVariants(enabled = true) {
  return useQuery<
    Array<{ sequenceId: string; hasVideo: boolean; hasMusic: boolean }>
  >({
    queryKey: sequenceVariantKeys.divergentByTeam(),
    queryFn: () => getTeamDivergentSequenceVariantsFn(),
    enabled,
    staleTime: 30_000,
  });
}

// ── Mutations: video ────────────────────────────────────────────────────────

type VariantMutationInput = { sequenceId: string; variantId: string };

export function usePromoteSequenceVideoVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { sequence: Sequence; variantId: string },
    Error,
    VariantMutationInput
  >({
    mutationFn: async (input) => promoteSequenceVideoVariantFn({ data: input }),
    onSuccess: async ({ sequence }, { sequenceId }) => {
      queryClient.setQueryData(sequenceKeys.detail(sequenceId), sequence);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceVariantKeys.divergentVideo(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
      ]);
    },
  });
}

export function useDiscardSequenceVideoVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    VariantMutationInput
  >({
    mutationFn: async (input) => discardSequenceVideoVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: sequenceVariantKeys.divergentVideo(sequenceId),
      });
    },
  });
}

export function useUndiscardSequenceVideoVariant() {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, VariantMutationInput>({
    mutationFn: async (input) =>
      undiscardSequenceVideoVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: sequenceVariantKeys.divergentVideo(sequenceId),
      });
    },
  });
}

// ── Mutations: music ────────────────────────────────────────────────────────

export function usePromoteSequenceMusicVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { sequence: Sequence; variantId: string },
    Error,
    VariantMutationInput
  >({
    mutationFn: async (input) => promoteSequenceMusicVariantFn({ data: input }),
    onSuccess: async ({ sequence }, { sequenceId }) => {
      queryClient.setQueryData(sequenceKeys.detail(sequenceId), sequence);
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: sequenceVariantKeys.divergentMusic(sequenceId),
        }),
        queryClient.invalidateQueries({
          queryKey: sequenceKeys.detail(sequenceId),
        }),
      ]);
    },
  });
}

export function useDiscardSequenceMusicVariant() {
  const queryClient = useQueryClient();
  return useMutation<
    { variantId: string; discardedAt: Date },
    Error,
    VariantMutationInput
  >({
    mutationFn: async (input) => discardSequenceMusicVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: sequenceVariantKeys.divergentMusic(sequenceId),
      });
    },
  });
}

export function useUndiscardSequenceMusicVariant() {
  const queryClient = useQueryClient();
  return useMutation<{ variantId: string }, Error, VariantMutationInput>({
    mutationFn: async (input) =>
      undiscardSequenceMusicVariantFn({ data: input }),
    onSuccess: async (_, { sequenceId }) => {
      await queryClient.invalidateQueries({
        queryKey: sequenceVariantKeys.divergentMusic(sequenceId),
      });
    },
  });
}
