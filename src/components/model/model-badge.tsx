import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import {
  AUDIO_MODELS,
  IMAGE_MODELS,
  IMAGE_TO_VIDEO_MODELS,
  isValidAudioModel,
  isValidImageToVideoModel,
  isValidTextToImageModel,
} from '@/lib/ai/models';
import { getAnalysisModelById } from '@/lib/ai/models.config';

export const ModelBadge = ({ model }: { model?: string }) => {
  if (!model) {
    return <Skeleton className="w-[100px] h-[20px]" />;
  }

  return (
    <Badge
      variant={
        (getAnalysisModelById(model)?.qualityRank ?? 99) <= 4
          ? 'default'
          : 'secondary'
      }
      className="text-xs"
    >
      {getAnalysisModelById(model)?.name || model}
    </Badge>
  );
};

export const ImageModelBadge = ({ model }: { model?: string }) => {
  if (!model) {
    return <Skeleton className="w-[100px] h-[20px]" />;
  }

  const modelConfig = isValidTextToImageModel(model)
    ? IMAGE_MODELS[model]
    : undefined;
  return (
    <Badge variant="secondary" className="text-xs">
      {modelConfig?.name || model}
    </Badge>
  );
};

export const VideoModelBadge = ({ model }: { model?: string }) => {
  if (!model) {
    return <Skeleton className="w-[100px] h-[20px]" />;
  }

  const modelConfig = isValidImageToVideoModel(model)
    ? IMAGE_TO_VIDEO_MODELS[model]
    : undefined;
  return (
    <Badge variant="secondary" className="text-xs">
      {modelConfig?.name || model}
    </Badge>
  );
};

export const MusicModelBadge = ({ model }: { model?: string }) => {
  if (!model) {
    return <Skeleton className="w-[100px] h-[20px]" />;
  }

  const modelConfig = isValidAudioModel(model)
    ? AUDIO_MODELS[model]
    : undefined;
  return (
    <Badge variant="secondary" className="text-xs">
      {modelConfig?.name || model}
    </Badge>
  );
};
