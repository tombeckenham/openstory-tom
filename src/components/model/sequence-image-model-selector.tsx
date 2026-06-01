import { AddModelMenuSection } from '@/components/model/add-model-menu';
import { Badge } from '@/components/ui/badge';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { useActiveImageModel } from '@/hooks/use-active-image-model';
import { useSequenceImageModels } from '@/hooks/use-frames';
import { IMAGE_MODELS, isValidTextToImageModel } from '@/lib/ai/models';
import { ChevronDown } from 'lucide-react';

function imageModelName(model: string): string {
  return isValidTextToImageModel(model) ? IMAGE_MODELS[model].name : model;
}

/**
 * Top-level image-model switcher for the sequence header. Lists the distinct
 * image models that have generated for this sequence (frame_variants) and lets
 * the viewer pick which model's image the scenes view shows; also hosts the
 * "Add a model" picker (#547). "Mixed" when more than one model has output and
 * none is pinned. Replaces the read-only ImageModelBadge.
 */
export const SequenceImageModelSelector = ({
  sequenceId,
  sequenceImageModel,
}: {
  sequenceId: string;
  sequenceImageModel?: string | null;
}) => {
  const { data: models } = useSequenceImageModels(sequenceId);
  const { activeImageModel, selectImageModel } =
    useActiveImageModel(sequenceId);

  if (!models || models.length === 0) {
    if (!sequenceImageModel) return null;
    return (
      <Badge variant="secondary" className="text-xs">
        {imageModelName(sequenceImageModel)}
      </Badge>
    );
  }

  const firstModel = models[0];
  const label = activeImageModel
    ? imageModelName(activeImageModel)
    : models.length === 1 && firstModel
      ? imageModelName(firstModel)
      : 'Mixed';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" aria-label="Select image model">
          <Badge variant="secondary" className="text-xs cursor-pointer gap-1">
            {label}
            <ChevronDown className="size-3" />
          </Badge>
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-[220px]">
        <DropdownMenuLabel className="text-xs">Image model</DropdownMenuLabel>
        <DropdownMenuSeparator />
        {models.length > 1 && (
          <DropdownMenuCheckboxItem
            checked={activeImageModel === null}
            onCheckedChange={() => selectImageModel(null)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            Mixed (per scene)
          </DropdownMenuCheckboxItem>
        )}
        {models.filter(isValidTextToImageModel).map((model) => (
          <DropdownMenuCheckboxItem
            key={model}
            checked={activeImageModel === model}
            onCheckedChange={() => selectImageModel(model)}
            onSelect={(e) => e.preventDefault()}
            className="cursor-pointer"
          >
            {imageModelName(model)}
          </DropdownMenuCheckboxItem>
        ))}
        <AddModelMenuSection
          sequenceId={sequenceId}
          variantType="image"
          usedModels={models}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
};
