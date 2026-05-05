import { computeWordDiff } from '@/lib/diff/word-diff';
import { cn } from '@/lib/utils';
import { useMemo } from 'react';

type PromptDiffViewProps = {
  before: string;
  after: string;
  className?: string;
};

export const PromptDiffView: React.FC<PromptDiffViewProps> = ({
  before,
  after,
  className,
}) => {
  const segments = useMemo(
    () => computeWordDiff(before, after),
    [before, after]
  );

  return (
    <p
      data-slot="prompt-diff"
      className={cn(
        'whitespace-pre-wrap break-words text-sm leading-relaxed text-foreground',
        className
      )}
    >
      {segments.map((seg, i) =>
        seg.kind === 'eq' ? (
          // eslint-disable-next-line react/no-array-index-key -- diff segments have no stable id
          <span key={i}>{seg.text}</span>
        ) : seg.kind === 'add' ? (
          <ins
            // eslint-disable-next-line react/no-array-index-key -- diff segments have no stable id
            key={i}
            aria-label="added"
            className="rounded bg-emerald-100 text-emerald-900 no-underline dark:bg-emerald-950 dark:text-emerald-100"
          >
            {seg.text}
          </ins>
        ) : (
          <del
            // eslint-disable-next-line react/no-array-index-key -- diff segments have no stable id
            key={i}
            aria-label="removed"
            className="rounded bg-rose-100 text-rose-900 line-through dark:bg-rose-950 dark:text-rose-100"
          >
            {seg.text}
          </del>
        )
      )}
    </p>
  );
};
