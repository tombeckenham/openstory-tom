import { Skeleton } from '@/components/ui/skeleton';
import type { Style } from '@/lib/db/schema/libraries';
import { cn } from '@/lib/utils';
import { Image } from '@unpic/react';
import { MoreHorizontal } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getStyleGradient } from './style-gradient';
import { StyleSelectionDialog } from './style-selection-dialog';

const StyleTileBackground: React.FC<{ style: Style }> = ({ style }) => {
  const [imgError, setImgError] = useState(false);

  return style.previewUrl && !imgError ? (
    <Image
      key={style.id}
      src={style.previewUrl}
      layout="fullWidth"
      alt={style.name}
      className="h-full w-full object-cover"
      onError={() => setImgError(true)}
    />
  ) : (
    <div
      className="h-full w-full"
      style={{
        background: getStyleGradient(style.config.colorPalette),
      }}
    />
  );
};

type StyleSelectorProps = {
  styles: Style[];
  selectedStyleId: string | null;
  onStyleSelect: (styleId: string) => void;
  loading?: boolean;
  disabled?: boolean;
};

export function StyleSelector({
  styles,
  selectedStyleId,
  onStyleSelect,
  loading = false,
  disabled = false,
}: StyleSelectorProps) {
  const [dialogOpen, setDialogOpen] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const [focusableIndex, setFocusableIndex] = useState(0);
  const [visibleCount, setVisibleCount] = useState(10);

  // Calculate columns from container width using ResizeObserver
  useEffect(() => {
    const container = gridRef.current;
    if (!container) return;

    const calculateColumns = (width: number) => {
      const tileSize = 65; // min tile width in px
      const gap = 12; // gap-3 = 12px
      const columns = Math.floor((width + gap) / (tileSize + gap));
      setVisibleCount(Math.max(3, columns)); // min 3 columns
    };

    // Initial calculation
    calculateColumns(container.clientWidth);

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) return;
      calculateColumns(entry.contentRect.width);
    });

    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  // Reorder styles to place selected style at the beginning if it exists
  const reorderedStyles = useMemo(() => {
    if (!selectedStyleId) return styles;

    const selectedIndex = styles.findIndex((s) => s.id === selectedStyleId);
    if (selectedIndex === -1) return styles;

    // If selected style is already in the visible positions, don't reorder
    if (selectedIndex < visibleCount - 1) return styles;

    // Move selected style to the front
    const selectedStyle = styles[selectedIndex];
    if (!selectedStyle) return styles;
    return [selectedStyle, ...styles.filter((s) => s.id !== selectedStyleId)];
  }, [styles, selectedStyleId, visibleCount]);

  // Always reserve last slot for "More" button, show visibleCount - 1 styles
  const visibleStyles = reorderedStyles.slice(0, visibleCount - 1);
  const hiddenCount = reorderedStyles.length - visibleStyles.length;

  // Reset focusable index when styles change or selected style changes
  useEffect(() => {
    if (visibleStyles.length === 0) return;

    // If a style is selected, make it focusable
    const selectedIndex = visibleStyles.findIndex(
      (s) => s.id === selectedStyleId
    );
    if (selectedIndex !== -1) {
      setFocusableIndex(selectedIndex);
    } else {
      // Otherwise, first item is focusable
      setFocusableIndex(0);
    }
  }, [selectedStyleId, visibleStyles]);

  // Handle arrow key navigation (single row, so left/right only)
  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent, currentIndex: number) => {
      const totalItems = visibleStyles.length + 1; // styles + "More" button
      let nextIndex = currentIndex;

      switch (event.key) {
        case 'ArrowRight':
        case 'ArrowDown':
          event.preventDefault();
          nextIndex = Math.min(currentIndex + 1, totalItems - 1);
          break;
        case 'ArrowLeft':
        case 'ArrowUp':
          event.preventDefault();
          nextIndex = Math.max(currentIndex - 1, 0);
          break;
        case 'Home':
          event.preventDefault();
          nextIndex = 0;
          break;
        case 'End':
          event.preventDefault();
          nextIndex = totalItems - 1;
          break;
        default:
          return;
      }

      if (nextIndex !== currentIndex) {
        setFocusableIndex(nextIndex);
        const buttons = gridRef.current?.querySelectorAll('button');
        const nextButton = buttons?.[nextIndex];
        if (nextButton instanceof HTMLElement) {
          nextButton.focus();
        }
      }
    },
    [visibleStyles.length]
  );

  const handleStyleSelect = (styleId: string) => {
    onStyleSelect(styleId);
    setDialogOpen(false);
  };

  return (
    <>
      <div
        ref={gridRef}
        className="grid grid-cols-[repeat(auto-fill,minmax(65px,1fr))] gap-3 overflow-hidden p-2"
        role="grid"
        aria-label="Style selection"
      >
        {loading
          ? Array.from({ length: visibleCount }).map((_, i) => (
              <Skeleton key={i} className="aspect-square rounded-lg" />
            ))
          : visibleStyles.map((style, index) => (
              <button
                key={style.id}
                type="button"
                onClick={() => onStyleSelect(style.id)}
                onKeyDown={(e) => handleKeyDown(e, index)}
                tabIndex={index === focusableIndex ? 0 : -1}
                disabled={disabled}
                className={cn(
                  'group relative aspect-square rounded-lg overflow-hidden',
                  'border-2 transition-all duration-200',
                  'hover:scale-105 hover:shadow-lg',
                  'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
                  'disabled:opacity-50 disabled:cursor-not-allowed',
                  selectedStyleId === style.id
                    ? 'border-primary shadow-md scale-105'
                    : 'border-transparent hover:border-primary/50'
                )}
                aria-label={`Select ${style.name} style`}
              >
                {/* Background Image / Gradient Fallback */}
                <StyleTileBackground style={style} />

                {/* Name Overlay on Image */}
                <div className="absolute inset-x-0 bottom-0 p-2 bg-linear-to-t from-black/80 via-black/60 to-transparent">
                  <p className="text-xs font-medium text-white text-center line-clamp-2">
                    {style.name}
                  </p>
                </div>

                {/* Selection Indicator */}
                {selectedStyleId === style.id && (
                  <div className="absolute inset-0 bg-primary/10 pointer-events-none" />
                )}
              </button>
            ))}

        {/* More Options Tile - Always show as last item in grid */}
        {!loading && (
          <button
            type="button"
            onClick={() => setDialogOpen(true)}
            onKeyDown={(e) => handleKeyDown(e, visibleStyles.length)}
            tabIndex={visibleStyles.length === focusableIndex ? 0 : -1}
            disabled={disabled}
            className={cn(
              'aspect-square rounded-lg overflow-hidden',
              'border-2 border-dashed border-muted-foreground/30',
              'flex flex-col items-center justify-center gap-2',
              'hover:border-primary hover:bg-muted/50',
              'transition-all duration-200',
              'focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2',
              'disabled:opacity-50 disabled:cursor-not-allowed'
            )}
            aria-label={`View all ${styles.length} styles`}
          >
            <MoreHorizontal className="h-5 w-5 text-muted-foreground" />
            <span className="text-xs text-muted-foreground font-medium text-center">
              {hiddenCount > 0
                ? `+${hiddenCount} More`
                : `View All (${reorderedStyles.length})`}
            </span>
          </button>
        )}
      </div>

      {/* Full Style Selection Dialog */}
      <StyleSelectionDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        styles={styles}
        selectedStyleId={selectedStyleId}
        onStyleSelect={handleStyleSelect}
      />
    </>
  );
}
