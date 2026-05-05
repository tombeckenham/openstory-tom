import { TheatreView } from '@/components/theatre/theatre-view';
import { SequenceVariantCompareDialog } from '@/components/sequence/sequence-variant-compare-dialog';
import { DivergentAlternateBanner } from '@/components/staleness/divergent-alternate-banner';
import { Skeleton } from '@/components/ui/skeleton';
import {
  useDiscardSequenceVideoVariant,
  usePromoteSequenceVideoVariant,
  useSequenceDivergentVideoVariants,
  useUndiscardSequenceVideoVariant,
} from '@/hooks/use-sequence-variants';
import { useSequence } from '@/hooks/use-sequences';
import type { AspectRatio } from '@/lib/constants/aspect-ratios';
import { useSequenceStaleDetected } from '@/lib/realtime/use-sequence-stale-detected';
import type { SequenceVideoVariant } from '@/lib/db/schema';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';

export const Route = createFileRoute('/_protected/sequences/$id/theatre')({
  component: TheatrePage,
  staticData: { breadcrumb: 'Theatre' },
});

// Constrain player to fit viewport. Header+tabs ≈ 10rem, so available ≈ 100dvh - 11rem.
// Full class names required for Tailwind JIT to detect at build time.
const THEATRE_MAX_CLASS_BY_RATIO: Record<AspectRatio, string> = {
  '16:9': 'w-full max-h-[calc(100dvh-15rem)] max-w-4xl',
  '9:16':
    'w-full max-h-[calc(100dvh-15rem)] max-w-[calc((100dvh-15rem)*0.5625)]',
  '1:1': 'w-full max-h-[calc(100dvh-15rem)] max-w-[calc(100dvh-15rem)]',
};

function TheatrePage() {
  const { id: sequenceId } = Route.useParams();

  const { data: sequence, isLoading } = useSequence(sequenceId, {
    refetchInterval: (query) => {
      if (query.state.data?.mergedVideoStatus === 'merging') return 2000;
      return false;
    },
  });

  // Only poll while merging in case realtime is down. Otherwise rely on
  // `useSequenceStaleDetected` + realtime invalidation.
  const merging = sequence?.mergedVideoStatus === 'merging';
  const { data: divergentVideoVariants } = useSequenceDivergentVideoVariants(
    sequenceId,
    merging ? { refetchInterval: 2000 } : undefined
  );
  useSequenceStaleDetected(sequenceId);

  const promoteVariant = usePromoteSequenceVideoVariant();
  const discardVariant = useDiscardSequenceVideoVariant();
  const undiscardVariant = useUndiscardSequenceVideoVariant();

  const [compareVariant, setCompareVariant] =
    useState<SequenceVideoVariant | null>(null);

  // If the variant disappears (e.g. concurrent promote from another tab),
  // close the dialog explicitly rather than silently null-rendering it.
  useEffect(() => {
    if (!compareVariant || !divergentVideoVariants) return;
    const stillExists = divergentVideoVariants.some(
      (v) => v.id === compareVariant.id
    );
    if (!stillExists) setCompareVariant(null);
  }, [compareVariant, divergentVideoVariants]);

  const handleDiscardWithUndo = useCallback(
    (variant: SequenceVideoVariant) => {
      const restore = () => {
        undiscardVariant.mutate(
          { sequenceId, variantId: variant.id },
          {
            onError: (error) => {
              toast.error('Failed to restore alternate', {
                description:
                  error instanceof Error ? error.message : 'Unknown error',
              });
            },
          }
        );
      };
      discardVariant.mutate(
        { sequenceId, variantId: variant.id },
        {
          onSuccess: () => {
            setCompareVariant(null);
            toast('Alternate discarded', {
              action: { label: 'Undo', onClick: restore },
            });
          },
          onError: (error) => {
            toast.error('Failed to discard alternate', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, discardVariant, undiscardVariant]
  );

  const handlePromote = useCallback(
    (variant: SequenceVideoVariant) => {
      promoteVariant.mutate(
        { sequenceId, variantId: variant.id },
        {
          onSuccess: () => {
            setCompareVariant(null);
            toast.success('Alternate promoted');
          },
          onError: (error) => {
            toast.error('Failed to promote alternate', {
              description:
                error instanceof Error ? error.message : 'Unknown error',
            });
          },
        }
      );
    },
    [sequenceId, promoteVariant]
  );

  // Reader orders by divergedAt asc — first row is the oldest pending.
  const latestDivergent = divergentVideoVariants?.[0];

  const divergentBanner = latestDivergent ? (
    <DivergentAlternateBanner
      variantId={latestDivergent.id}
      artifact="merged-video"
      entityType="sequence"
      onCompare={() => setCompareVariant(latestDivergent)}
      onPromote={() => handlePromote(latestDivergent)}
      onDiscard={() => handleDiscardWithUndo(latestDivergent)}
    />
  ) : null;

  if (isLoading || !sequence) {
    return (
      <div className="flex-1 p-4">
        <Skeleton className="aspect-video w-full max-w-4xl mx-auto" />
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center p-4">
      <div className={THEATRE_MAX_CLASS_BY_RATIO[sequence.aspectRatio]}>
        <TheatreView sequence={sequence} divergentBanner={divergentBanner} />
      </div>
      {compareVariant && (
        <SequenceVariantCompareDialog
          kind="video"
          open={true}
          onOpenChange={(open) => {
            if (!open) setCompareVariant(null);
          }}
          sequence={sequence}
          variant={compareVariant}
          onPromote={() => handlePromote(compareVariant)}
          onDiscard={() => handleDiscardWithUndo(compareVariant)}
          isPromoting={promoteVariant.isPending}
          isDiscarding={discardVariant.isPending}
        />
      )}
    </div>
  );
}
