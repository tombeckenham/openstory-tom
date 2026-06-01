import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { AddModelMenuSection } from '@/components/model/add-model-menu';
import { useActiveAudioModel } from '@/hooks/use-active-audio-model';
import { useSequenceAudioModels } from '@/hooks/use-sequences';
import { AUDIO_MODELS, isValidAudioModel } from '@/lib/ai/models';
import { Check, ChevronDown, CircleCheck } from 'lucide-react';

function audioModelName(model: string): string {
  return isValidAudioModel(model) ? AUDIO_MODELS[model].name : model;
}

/**
 * Top-level audio-model switcher for the sequence header (#546). Audio is
 * per-sequence — one track plays at a time — so there is no "Mixed" state
 * (that's a video-only, per-scene concept). The dropdown just chooses which
 * model's track this viewer hears (localStorage via useActiveAudioModel): the
 * live primary is marked ⊙ `set`, other models that have generated a track are
 * marked ✓ and can be previewed here, then promoted ("Set Music") from the
 * music tab. When nothing is pinned, the primary plays.
 */
export const SequenceAudioModelSelector = ({
  sequenceId,
  sequenceMusicModel,
}: {
  sequenceId: string;
  sequenceMusicModel?: string | null;
}) => {
  const { data: models } = useSequenceAudioModels(sequenceId);
  const { activeAudioModel, selectAudioModel } =
    useActiveAudioModel(sequenceId);

  if (!models || models.length === 0) {
    if (!sequenceMusicModel) return null;
    return (
      <Badge variant="secondary" className="text-xs">
        {audioModelName(sequenceMusicModel)}
      </Badge>
    );
  }

  // The live primary track's model (what plays when nothing is pinned).
  const primaryModel = sequenceMusicModel ?? models[0] ?? null;
  // What this viewer currently hears: the pinned model, else the primary.
  const effectiveModel = activeAudioModel ?? primaryModel;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Select audio model">
          <Badge variant="secondary" className="text-xs cursor-pointer gap-1">
            {effectiveModel ? audioModelName(effectiveModel) : 'Audio model'}
            <ChevronDown className="size-3" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        <DropdownMenuLabel className="text-xs">Audio model</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.filter(isValidAudioModel).map((model) => {
          const isPrimary = model === primaryModel;
          return (
            <DropdownMenuCheckboxItem
              key={model}
              checked={effectiveModel === model}
              // Pinning the primary is equivalent to no pick — store null so
              // this viewer keeps following the primary if it later changes.
              onCheckedChange={() => selectAudioModel(isPrimary ? null : model)}
              onSelect={(e) => e.preventDefault()}
              className="cursor-pointer"
            >
              <span className="flex items-center gap-2">
                {isPrimary ? (
                  <CircleCheck
                    className="size-3.5 shrink-0 text-emerald-500"
                    aria-label="Currently set"
                  />
                ) : (
                  <Check
                    className="size-3.5 shrink-0 text-muted-foreground"
                    aria-label="Generated"
                  />
                )}
                {audioModelName(model)}
              </span>
            </DropdownMenuCheckboxItem>
          );
        })}
        <AddModelMenuSection
          sequenceId={sequenceId}
          variantType="audio"
          usedModels={models}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
