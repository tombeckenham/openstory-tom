import {
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
} from '@/components/ui/dropdown-menu';
import { useAddModelToSequence, useSequence } from '@/hooks/use-sequences';
import { useFramesBySequence } from '@/hooks/use-frames';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isModelCompatibleWithAspectRatio,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
} from '@/lib/ai/models';
import type { VariantType } from '@/lib/db/schema/frame-variants';
import {
  estimateAudioCost,
  estimateImageCost,
  estimateVideoCost,
} from '@/lib/billing/cost-estimation';
import {
  microsToUsd,
  multiplyMicros,
  type Microdollars,
} from '@/lib/billing/money';
import { DEFAULT_ASPECT_RATIO } from '@/lib/constants/aspect-ratios';
import { useMemo } from 'react';
import { toast } from 'sonner';

type Candidate = {
  key: string;
  name: string;
  cost: Microdollars;
  scope: string;
};

/**
 * "Add a model" section for the header model dropdowns (#547). Lists models of
 * the given type that have NOT yet generated for this sequence, with a rough
 * cost + scope estimate; clicking confirms via a toast then triggers
 * addModelToSequenceFn (which generates the new model for every frame / the
 * whole sequence using the existing prompts). The server runs the authoritative
 * credit pre-flight; the estimate here is advisory.
 */
export const AddModelMenuSection = ({
  sequenceId,
  variantType,
  usedModels,
}: {
  sequenceId: string;
  variantType: VariantType;
  usedModels: string[];
}) => {
  const addModel = useAddModelToSequence();
  const { data: frames } = useFramesBySequence(sequenceId);
  const { data: sequence } = useSequence(sequenceId);
  const aspectRatio = sequence?.aspectRatio ?? DEFAULT_ASPECT_RATIO;

  const candidates = useMemo<Candidate[]>(() => {
    const used = new Set(usedModels);
    const frameList = frames ?? [];
    const totalDurationSecs =
      frameList.reduce(
        (sum, f) =>
          sum +
          (f.durationMs
            ? f.durationMs / 1000
            : (f.metadata?.metadata?.durationSeconds ?? 10)),
        0
      ) || 30;

    if (variantType === 'image') {
      const count = frameList.filter(
        (f) =>
          f.imagePrompt ||
          f.metadata?.prompts?.visual?.fullPrompt ||
          f.description
      ).length;
      return Object.keys(IMAGE_MODELS)
        .filter(isValidTextToImageModel)
        .filter((key) => !used.has(key) && !('hidden' in IMAGE_MODELS[key]))
        .sort(
          (a, b) => IMAGE_MODELS[a].qualityRank - IMAGE_MODELS[b].qualityRank
        )
        .map((key) => ({
          key,
          name: IMAGE_MODELS[key].name,
          cost: multiplyMicros(
            estimateImageCost(key, aspectRatio, 1),
            count || 1
          ),
          scope: `${count || 'all'} scene${count === 1 ? '' : 's'}`,
        }));
    }

    if (variantType === 'video') {
      const count = frameList.filter(
        (f) => f.thumbnailStatus === 'completed' && f.thumbnailUrl
      ).length;
      return Object.keys(IMAGE_TO_VIDEO_MODELS)
        .filter(isValidImageToVideoModel)
        .filter(
          (key) =>
            !used.has(key) &&
            !('hidden' in IMAGE_TO_VIDEO_MODELS[key]) &&
            isModelCompatibleWithAspectRatio(key, aspectRatio)
        )
        .sort(
          (a, b) =>
            IMAGE_TO_VIDEO_MODELS[a].qualityRank -
            IMAGE_TO_VIDEO_MODELS[b].qualityRank
        )
        .map((key) => ({
          key,
          name: IMAGE_TO_VIDEO_MODELS[key].name,
          cost: multiplyMicros(estimateVideoCost(key, 5), count || 1),
          scope: `${count || 0} scene${count === 1 ? '' : 's'}`,
        }));
    }

    // audio — one track for the whole sequence
    return Object.keys(AUDIO_MODELS)
      .filter(isValidAudioModel)
      .filter(
        // oxlint-disable-next-line typescript/no-unnecessary-condition
        (key) => !used.has(key) && AUDIO_MODELS[key].type === 'music'
      )
      .sort((a, b) => AUDIO_MODELS[a].qualityRank - AUDIO_MODELS[b].qualityRank)
      .map((key) => ({
        key,
        name: AUDIO_MODELS[key].name,
        cost: estimateAudioCost(key, totalDurationSecs),
        scope: '1 track',
      }));
  }, [variantType, usedModels, frames, aspectRatio]);

  if (candidates.length === 0) return null;

  // Audio requires a generated music prompt; gate the section in that case.
  const audioBlocked =
    variantType === 'audio' && !(sequence?.musicPrompt && sequence.musicTags);

  const handleAdd = (key: string, name: string, cost: Microdollars) => {
    toast(`Add ${name}?`, {
      description: audioBlocked
        ? 'Generate music once before adding another audio model.'
        : `Generates ~$${microsToUsd(cost).toFixed(2)} of content using the existing prompts.`,
      action: audioBlocked
        ? undefined
        : {
            label: 'Add',
            onClick: () => {
              addModel.mutate(
                { sequenceId, variantType, model: key },
                {
                  onSuccess: (r) =>
                    toast.success(`Generating ${name} (${r.count})…`),
                  onError: (e) => toast.error(e.message),
                }
              );
            },
          },
    });
  };

  return (
    <>
      <DropdownMenuSeparator />
      <DropdownMenuLabel className="text-[10px] text-muted-foreground uppercase tracking-wider font-normal">
        Add a model
      </DropdownMenuLabel>
      {candidates.map((c) => (
        <DropdownMenuItem
          key={c.key}
          disabled={addModel.isPending}
          onSelect={(e) => {
            e.preventDefault();
            handleAdd(c.key, c.name, c.cost);
          }}
          className="cursor-pointer flex items-center justify-between gap-3"
        >
          <span className="truncate">{c.name}</span>
          <span className="shrink-0 text-[10px] text-muted-foreground">
            {c.scope} · ~${microsToUsd(c.cost).toFixed(2)}
          </span>
        </DropdownMenuItem>
      ))}
    </>
  );
};
