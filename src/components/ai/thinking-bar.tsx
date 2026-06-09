import { cn } from '@/lib/utils';
import { Brain } from 'lucide-react';
import type { FC } from 'react';

/**
 * Minimal "Thinking…" indicator shown while the model is in its reasoning pass,
 * before any output streams. Deliberately content-free: the reasoning tokens
 * themselves are scratch work and aren't surfaced — this is just a status bar
 * that the model is working. Renders nothing when not active.
 */
export const ThinkingBar: FC<{ active: boolean; className?: string }> = ({
  active,
  className,
}) => {
  if (!active) return null;

  return (
    <div
      aria-live="polite"
      className={cn(
        'flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs font-medium text-muted-foreground',
        className
      )}
    >
      <Brain className="size-3.5 shrink-0 animate-pulse" aria-hidden />
      <span>Thinking…</span>
    </div>
  );
};
