import { ImageModelSelector } from '@/components/model/image-model-selector';
import { Skeleton } from '@/components/ui/skeleton';
import { useActiveImageModel } from '@/hooks/use-active-model';
import {
  IMAGE_MODELS,
  isValidTextToImageModel,
  type TextToImageModel,
} from '@/lib/ai/models';
import type { FC } from 'react';

type ImageModelDropdownProps = {
  sequenceId: string;
};

export const ImageModelDropdown: FC<ImageModelDropdownProps> = ({
  sequenceId,
}) => {
  const { activeModel, setActiveModel, availableModels, isLoading } =
    useActiveImageModel(sequenceId);

  if (isLoading) {
    return <Skeleton className="h-7 w-28" />;
  }

  // No variants yet — nothing to show
  if (availableModels.length === 0) {
    return null;
  }

  // Single model — show as a static badge-like display
  if (availableModels.length === 1) {
    const model = availableModels[0];
    const name = isValidTextToImageModel(model)
      ? IMAGE_MODELS[model].name
      : model;
    return (
      <span className="inline-flex items-center rounded-md border px-2 py-0.5 text-xs font-medium text-muted-foreground">
        {name}
      </span>
    );
  }

  const validActive =
    activeModel && isValidTextToImageModel(activeModel)
      ? activeModel
      : undefined;

  const validModels = availableModels.filter(isValidTextToImageModel);

  if (!validActive || validModels.length === 0) {
    return null;
  }

  return (
    <ImageModelSelector
      selectedModel={validActive}
      onModelChange={(model: TextToImageModel) => setActiveModel(model)}
      filterModels={validModels}
    />
  );
};
