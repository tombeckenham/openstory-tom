import { AspectRatioIcon } from '@/components/icons/aspect-ratio-icon';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip';
import {
  ASPECT_RATIOS,
  aspectRatioSchema,
  type AspectRatio,
} from '@/lib/constants/aspect-ratios';
import { useEffect, type FC } from 'react';

function isValidAspectRatio(value: string): value is AspectRatio {
  return aspectRatioSchema.safeParse(value).success;
}

type AspectRatioPillsProps = {
  value: AspectRatio;
  onChange: (value: AspectRatio) => void;
  /** Style-recommended aspect ratio — renders a "Recommended" badge on the match. */
  recommendedAspectRatio?: string | null;
  /** Style name, used in the recommendation tooltip. */
  styleName?: string;
};

export const AspectRatioPills: FC<AspectRatioPillsProps> = ({
  value,
  onChange,
  recommendedAspectRatio,
  styleName,
}) => {
  const tooltipText = styleName
    ? `Recommended for ${styleName}`
    : 'Recommended for this style';

  // Warn when a style's recommendation references a ratio we don't render —
  // otherwise the badge silently disappears with no signal.
  useEffect(() => {
    if (!recommendedAspectRatio) return;
    if (!ASPECT_RATIOS.some((r) => r.value === recommendedAspectRatio)) {
      console.warn(
        '[AspectRatioPills] recommendedAspectRatio did not match any rendered ratio',
        { recommendedAspectRatio, styleName }
      );
    }
  }, [recommendedAspectRatio, styleName]);

  return (
    <ToggleGroup
      type="single"
      value={value}
      onValueChange={(val) => {
        if (val && isValidAspectRatio(val)) {
          onChange(val);
        }
      }}
      variant="outline"
      className="justify-start"
    >
      {ASPECT_RATIOS.map((ratio) => {
        const isRecommended =
          recommendedAspectRatio !== null &&
          recommendedAspectRatio !== undefined &&
          recommendedAspectRatio === ratio.value;
        const item = (
          <ToggleGroupItem
            key={ratio.value}
            value={ratio.value}
            className="flex items-center gap-2 h-9 px-3"
            aria-label={`${ratio.label} aspect ratio${
              isRecommended ? ' (recommended)' : ''
            }`}
          >
            <AspectRatioIcon
              width={ratio.width}
              height={ratio.height}
              size="sm"
            />
            <span className="font-mono text-xs">{ratio.label}</span>
            {isRecommended && (
              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                Recommended
              </span>
            )}
          </ToggleGroupItem>
        );
        if (!isRecommended) return item;
        return (
          <TooltipProvider key={ratio.value}>
            <Tooltip>
              <TooltipTrigger asChild>{item}</TooltipTrigger>
              <TooltipContent>{tooltipText}</TooltipContent>
            </Tooltip>
          </TooltipProvider>
        );
      })}
    </ToggleGroup>
  );
};
