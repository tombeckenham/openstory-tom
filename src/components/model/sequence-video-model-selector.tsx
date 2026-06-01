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
import { useActiveVideoModel } from '@/hooks/use-active-video-model';
import { useSequenceVideoModels } from '@/hooks/use-frames';
import {
  IMAGE_TO_VIDEO_MODELS,
  isValidImageToVideoModel,
} from '@/lib/ai/models';
import { ChevronDown } from 'lucide-react';

function videoModelName(model: string): string {
  return isValidImageToVideoModel(model)
    ? IMAGE_TO_VIDEO_MODELS[model].name
    : model;
}

/**
 * Top-level video-model switcher for the sequence header (#545). Replaces the
 * old read-only video-model chip once any video variants exist: lists the
 * distinct models that have generated a video for this sequence (derived from
 * frame_variants) and lets the viewer pick which model's output to display.
 * The selection is viewer-local (localStorage via useActiveVideoModel).
 *
 * "Mixed" is shown when more than one model has output and the viewer has not
 * pinned a specific one — i.e. each scene shows its own model's video.
 */
export const SequenceVideoModelSelector = ({
  sequenceId,
  sequenceVideoModel,
}: {
  sequenceId: string;
  sequenceVideoModel?: string | null;
}) => {
  const { data: models } = useSequenceVideoModels(sequenceId);
  const { activeVideoModel, selectVideoModel } =
    useActiveVideoModel(sequenceId);

  // No video variants generated yet — fall back to the read-only chip showing
  // the sequence's configured model (or render nothing when motion is off).
  if (!models || models.length === 0) {
    if (!sequenceVideoModel) return null;
    return (
      <Badge variant="secondary" className="text-xs">
        {videoModelName(sequenceVideoModel)}
      </Badge>
    );
  }

  const firstModel = models[0];
  const label = activeVideoModel
    ? videoModelName(activeVideoModel)
    : models.length === 1 && firstModel
      ? videoModelName(firstModel)
      : 'Mixed';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Select video model">
          <Badge variant="secondary" className="text-xs cursor-pointer gap-1">
            {label}
            <ChevronDown className="size-3" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[200px]">
        <DropdownMenuLabel className="text-xs">Video model</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.length > 1 && (
          <DropdownMenuCheckboxItem
            checked={activeVideoModel === null}
            onCheckedChange={() => selectVideoModel(null)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            Mixed (per scene)
          </DropdownMenuCheckboxItem>
        )}
        {models.filter(isValidImageToVideoModel).map((model) => (
          <DropdownMenuCheckboxItem
            key={model}
            checked={activeVideoModel === model}
            onCheckedChange={() => selectVideoModel(model)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            {videoModelName(model)}
          </DropdownMenuCheckboxItem>
        ))}
        <AddModelMenuSection
          sequenceId={sequenceId}
          variantType="video"
          usedModels={models}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
