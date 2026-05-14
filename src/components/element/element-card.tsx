import { Button } from '@/components/ui/button';
import {
  useDeleteSequenceElement,
  useRenameSequenceElementToken,
  useReplaceSequenceElement,
} from '@/hooks/use-sequence-elements';
import type { SequenceElement } from '@/lib/db/schema';
import { Loader2, RefreshCw, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { toast } from 'sonner';
import { ReplaceElementConfirmDialog } from './replace-element-confirm-dialog';

type ElementCardProps = {
  element: SequenceElement;
  sequenceId: string;
  affectedFrameCount: number;
};

export const ElementCard: React.FC<ElementCardProps> = ({
  element,
  sequenceId,
  affectedFrameCount,
}) => {
  const deleteMutation = useDeleteSequenceElement();
  const renameMutation = useRenameSequenceElementToken();
  const replaceMutation = useReplaceSequenceElement();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const handleFileSelected = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Reset the input so re-selecting the same file fires onChange.
    e.target.value = '';
    if (!file) return;
    setPendingFile(file);
    setConfirmOpen(true);
  };

  const handleConfirm = () => {
    if (!pendingFile) return;
    replaceMutation.mutate(
      { file: pendingFile, sequenceId, elementId: element.id },
      {
        onSuccess: (result) => {
          setConfirmOpen(false);
          setPendingFile(null);
          const count = result.affectedFrameIds.length;
          toast.success(
            count > 0
              ? `Replaced ${element.token} — editing ${count} frame${count === 1 ? '' : 's'}…`
              : `Replaced ${element.token}`
          );
        },
        onError: (err) => {
          toast.error('Failed to replace element', {
            description: err instanceof Error ? err.message : 'Unknown error',
          });
        },
      }
    );
  };

  const isReplacing =
    replaceMutation.isPending || element.visionStatus === 'analyzing';

  return (
    <>
      <div className="flex flex-col gap-3 rounded-lg border border-border bg-card p-3">
        <div className="relative aspect-video overflow-hidden rounded-md bg-muted">
          {isReplacing ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/70 backdrop-blur-sm">
              <Loader2 className="size-6 animate-spin text-muted-foreground" />
              <p className="text-xs text-muted-foreground">
                {replaceMutation.isPending ? 'Uploading…' : 'Editing frames…'}
              </p>
            </div>
          ) : null}
          <img
            src={element.imageUrl}
            alt={element.uploadedFilename}
            className="size-full object-contain"
          />
        </div>
        <div className="flex items-center justify-between gap-2">
          <input
            type="text"
            defaultValue={element.token}
            className="flex-1 rounded-md border border-input bg-background px-2 py-1 font-mono text-sm"
            onBlur={(e) => {
              const next = e.currentTarget.value.trim();
              if (next && next.toUpperCase() !== element.token) {
                renameMutation.mutate({
                  elementId: element.id,
                  sequenceId,
                  token: next,
                });
              }
            }}
          />
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={isReplacing}
            aria-label={`Replace ${element.token} image`}
            title="Replace image"
            onClick={() => fileInputRef.current?.click()}
          >
            <RefreshCw className="size-4" />
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="icon"
            disabled={deleteMutation.isPending || isReplacing}
            aria-label={`Delete ${element.token}`}
            onClick={() =>
              deleteMutation.mutate({
                elementId: element.id,
                sequenceId,
              })
            }
          >
            <Trash2 className="size-4" />
          </Button>
        </div>
        <div className="text-xs text-muted-foreground">
          {element.visionStatus === 'pending' ||
          element.visionStatus === 'analyzing' ? (
            <span className="inline-flex items-center gap-1">
              <Loader2 className="size-3 animate-spin" />
              Analyzing image…
            </span>
          ) : element.visionStatus === 'failed' ? (
            <span className="text-destructive">
              Vision failed: {element.visionError ?? 'unknown error'}
            </span>
          ) : (
            <span>{element.description ?? 'No description'}</span>
          )}
        </div>
        {affectedFrameCount > 0 ? (
          <p className="text-xs text-muted-foreground/70">
            Used in {affectedFrameCount} frame
            {affectedFrameCount === 1 ? '' : 's'}
          </p>
        ) : null}
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileSelected}
      />

      {pendingFile ? (
        <ReplaceElementConfirmDialog
          open={confirmOpen}
          onOpenChange={(next) => {
            setConfirmOpen(next);
            if (!next) setPendingFile(null);
          }}
          onConfirm={handleConfirm}
          token={element.token}
          newFilename={pendingFile.name}
          affectedFrameCount={affectedFrameCount}
          isLoading={replaceMutation.isPending}
        />
      ) : null}
    </>
  );
};
