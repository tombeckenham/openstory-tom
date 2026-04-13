import type React from 'react';
import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ModelBadge } from '@/components/model/model-badge';
import type { SequenceWithFrames } from '@/hooks/use-sequences-with-frames';
import { getImageModelById } from '@/lib/ai/models';
import { getAspectRatioData } from '@/lib/constants/aspect-ratios';
import { formatDistanceToNow } from '@/lib/utils';
import { formatDuration } from '@/lib/utils/format-duration';
import { Route as sequencesScenesRoute } from '@/routes/_protected/sequences/$id/scenes';
import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  Calendar,
  ImageIcon,
  Timer,
  User,
  Workflow,
} from 'lucide-react';

type EvalSequenceMetadataProps = {
  sequence: SequenceWithFrames;
};

export const EvalSequenceMetadata: React.FC<EvalSequenceMetadataProps> = ({
  sequence,
}) => {
  const ratioData = getAspectRatioData(sequence.aspectRatio);
  const imageModel = getImageModelById(sequence.imageModel);

  return (
    <div className="h-full border-r border-b p-3 flex flex-col gap-2">
      {/* Title */}
      <Link
        to={sequencesScenesRoute.fullPath}
        params={{ id: sequence.id }}
        className="font-medium text-sm line-clamp-2 hover:underline"
        title={sequence.title || 'Untitled Sequence'}
      >
        {sequence.title || 'Untitled Sequence'}
      </Link>

      {/* Creator Name (in support mode) */}
      {'creatorName' in sequence &&
        typeof sequence.creatorName === 'string' && (
          <div className="flex items-center gap-1 text-xs text-muted-foreground">
            <User className="h-3 w-3" />
            <span className="truncate">{sequence.creatorName}</span>
          </div>
        )}

      {/* Analysis Model */}
      <ModelBadge model={sequence.analysisModel} />

      {/* Image Model */}
      {imageModel && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <ImageIcon className="h-3 w-3" />
          <span className="truncate">{imageModel.name}</span>
        </div>
      )}

      {/* Workflow */}
      {sequence.workflow && (
        <div className="flex items-center gap-1 text-xs text-muted-foreground">
          <Workflow className="h-3 w-3" />
          <span className="truncate">{sequence.workflow}</span>
        </div>
      )}

      {/* Metadata Row */}
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        {/* Created Date */}
        <div className="flex items-center gap-1">
          <Calendar className="h-3 w-3" />
          <span>{formatDistanceToNow(new Date(sequence.createdAt))}</span>
        </div>

        {/* Analysis Duration */}
        {sequence.analysisDurationMs > 0 && (
          <div className="flex items-center gap-1">
            <Timer className="h-3 w-3" />
            <span>{formatDuration(sequence.analysisDurationMs)}</span>
          </div>
        )}

        {/* Aspect Ratio */}
        {ratioData && (
          <div className="flex items-center gap-1">
            <AspectRatioIcon
              width={ratioData.width}
              height={ratioData.height}
              size="sm"
            />
            <span>{ratioData.label}</span>
          </div>
        )}
      </div>

      {/* Frame Count */}
      <div className="text-xs text-muted-foreground">
        {sequence.frames.length} scene{sequence.frames.length !== 1 ? 's' : ''}
      </div>

      {/* Errors */}
      <SequenceErrors sequence={sequence} />
    </div>
  );
};

const SequenceErrors: React.FC<{ sequence: SequenceWithFrames }> = ({
  sequence,
}) => {
  const errors: string[] = [];

  if (sequence.status === 'failed') {
    errors.push(sequence.statusError ?? 'Sequence failed');
  }
  if (sequence.mergedVideoError) {
    errors.push(`Merge: ${sequence.mergedVideoError}`);
  }
  if (sequence.musicError) {
    errors.push(`Music: ${sequence.musicError}`);
  }

  const failedImages = sequence.frames.filter(
    (f) => f.thumbnailStatus === 'failed'
  ).length;
  const failedVideos = sequence.frames.filter(
    (f) => f.videoStatus === 'failed'
  ).length;

  if (failedImages > 0) {
    errors.push(`${failedImages} image${failedImages > 1 ? 's' : ''} failed`);
  }
  if (failedVideos > 0) {
    errors.push(`${failedVideos} video${failedVideos > 1 ? 's' : ''} failed`);
  }

  if (errors.length === 0) return null;

  return (
    <div className="flex flex-col gap-1">
      {errors.map((err) => (
        <div
          key={err}
          className="flex items-start gap-1 text-xs text-destructive"
        >
          <AlertTriangle className="h-3 w-3 shrink-0 mt-0.5" />
          <span className="line-clamp-2">{err}</span>
        </div>
      ))}
    </div>
  );
};
