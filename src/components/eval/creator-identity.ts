import type { SequenceWithFrames } from '@/hooks/use-sequences-with-frames';

export type CreatorIdentity = {
  name: string | null;
  email: string | null;
};

export function getCreatorIdentity(
  sequence: Pick<SequenceWithFrames, 'creatorName' | 'creatorEmail'>
): CreatorIdentity {
  return {
    name: sequence.creatorName ?? null,
    email: sequence.creatorEmail ?? null,
  };
}
