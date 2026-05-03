import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Loader2 } from 'lucide-react';
import type { Frame, FrameVariant } from '@/lib/db/schema';
import type { VariantType } from '@/lib/db/schema/frame-variants';

type DivergenceCompareDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  frame: Frame;
  variant: FrameVariant;
  onPromote: () => void;
  onDiscard: () => void;
  isPromoting?: boolean;
  isDiscarding?: boolean;
  /**
   * Optional list of upstream entity changes between the snapshot and live
   * inputs. Stage 1 surfaces this as a flat string list; field-level diffs
   * land in stage 4.
   */
  upstreamChanges?: string[];
};

const ARTIFACT_LABEL: Record<VariantType, string> = {
  image: 'image',
  video: 'video',
  audio: 'audio',
};

function liveAssetForVariant(
  frame: Frame,
  variantType: VariantType
): { url: string | null; kind: 'image' | 'video' | 'audio' } {
  switch (variantType) {
    case 'image':
      return { url: frame.thumbnailUrl, kind: 'image' };
    case 'video':
      return { url: frame.videoUrl, kind: 'video' };
    case 'audio':
      return { url: frame.audioUrl, kind: 'audio' };
  }
}

const AssetPreview: React.FC<{
  url: string | null | undefined;
  kind: 'image' | 'video' | 'audio';
  alt: string;
}> = ({ url, kind, alt }) => {
  if (!url) {
    return (
      <div className="flex aspect-video items-center justify-center rounded-md border border-dashed border-muted-foreground/40 text-xs text-muted-foreground">
        No asset
      </div>
    );
  }
  if (kind === 'image') {
    return (
      // Compare-dialog is a transient surface; the unpic optimisation pipeline
      // adds little here and the variant URL may already be a CDN-resized one.
      // Plain img keeps this simple and aligns with the existing variant
      // selector dialog.
      // eslint-disable-next-line @next/next/no-img-element
      <img
        src={url}
        alt={alt}
        className="aspect-video w-full rounded-md object-cover"
      />
    );
  }
  if (kind === 'video') {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption -- Compare-dialog renders user-supplied generated assets that have no caption track.
      <video
        src={url}
        controls
        className="aspect-video w-full rounded-md bg-black"
      />
    );
  }
  // eslint-disable-next-line jsx-a11y/media-has-caption -- Compare-dialog renders user-supplied generated audio without captions.
  return <audio src={url} controls className="w-full" />;
};

export const DivergenceCompareDialog: React.FC<
  DivergenceCompareDialogProps
> = ({
  open,
  onOpenChange,
  frame,
  variant,
  onPromote,
  onDiscard,
  isPromoting = false,
  isDiscarding = false,
  upstreamChanges,
}) => {
  const live = liveAssetForVariant(frame, variant.variantType);
  const label = ARTIFACT_LABEL[variant.variantType];
  const busy = isPromoting || isDiscarding;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>Compare alternate {label}</DialogTitle>
          <DialogDescription>
            An alternate {label} was generated from the inputs you had at the
            time. Compare it against the live version, then promote or discard.
          </DialogDescription>
        </DialogHeader>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">Live (current inputs)</span>
            <AssetPreview
              url={live.url}
              kind={live.kind}
              alt={`Live ${label}`}
            />
          </div>
          <div className="flex flex-col gap-2">
            <span className="text-sm font-medium">
              Alternate (older inputs)
            </span>
            <AssetPreview
              url={variant.url}
              kind={live.kind}
              alt={`Alternate ${label}`}
            />
          </div>
        </div>

        {upstreamChanges && upstreamChanges.length > 0 && (
          <div className="flex flex-col gap-2 rounded-md border bg-muted/30 p-3">
            <span className="text-sm font-medium">What changed</span>
            <ul className="flex flex-col gap-1 text-sm text-muted-foreground">
              {upstreamChanges.map((change) => (
                <li key={change}>• {change}</li>
              ))}
            </ul>
          </div>
        )}

        <DialogFooter className="flex flex-row justify-end gap-2">
          <Button
            type="button"
            variant="ghost"
            onClick={onDiscard}
            disabled={busy}
          >
            {isDiscarding && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Discard
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            Cancel
          </Button>
          <Button type="button" onClick={onPromote} disabled={busy}>
            {isPromoting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Promote
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
