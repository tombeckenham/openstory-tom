import { cn } from '@/lib/utils';
import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { GripVertical } from 'lucide-react';

type SortableSceneItemProps = {
  id: string;
  disabled?: boolean;
  children: React.ReactNode;
};

/**
 * Wraps a SceneListItem with drag-to-reorder behaviour. The grip handle is the
 * only drag activator, so clicking the card body still selects the scene and the
 * handle stays keyboard-operable (focus it, then arrow keys reorder) per the
 * WAI-ARIA reorder pattern. The handle reserves its own gutter rather than
 * overlapping the thumbnail.
 */
export const SortableSceneItem: React.FC<SortableSceneItemProps> = ({
  id,
  disabled = false,
  children,
}) => {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn('flex items-stretch', isDragging && 'z-10 opacity-80')}
    >
      {!disabled && (
        <button
          type="button"
          aria-label="Drag to reorder scene"
          className={cn(
            'flex w-5 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm',
            'text-muted-foreground/30 transition-colors hover:text-muted-foreground',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            'active:cursor-grabbing'
          )}
          {...attributes}
          {...listeners}
        >
          <GripVertical className="h-4 w-4" />
        </button>
      )}
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
};
