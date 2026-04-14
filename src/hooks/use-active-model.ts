import { getSequenceImageModelsFn } from '@/functions/frames';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY_PREFIX = 'openstory:active-image-model:';

function getStorageKey(sequenceId: string) {
  return `${STORAGE_KEY_PREFIX}${sequenceId}`;
}

function getSnapshot(sequenceId: string): string | null {
  if (typeof window === 'undefined') return null;
  try {
    return localStorage.getItem(getStorageKey(sequenceId));
  } catch {
    return null;
  }
}

function subscribe(callback: () => void): () => void {
  window.addEventListener('storage', callback);
  return () => window.removeEventListener('storage', callback);
}

export function useActiveImageModel(sequenceId: string) {
  const { data: availableModels = [], isLoading } = useQuery({
    queryKey: ['sequence-image-models', sequenceId],
    queryFn: () => getSequenceImageModelsFn({ data: { sequenceId } }),
    staleTime: 30_000,
  });

  const storedModel = useSyncExternalStore(
    subscribe,
    () => getSnapshot(sequenceId),
    () => null
  );

  // Resolve active model: stored preference > first available > null
  const activeModel =
    storedModel && availableModels.includes(storedModel)
      ? storedModel
      : (availableModels[0] ?? null);

  const setActiveModel = useCallback(
    (model: string) => {
      try {
        localStorage.setItem(getStorageKey(sequenceId), model);
        // Dispatch storage event for cross-tab sync
        window.dispatchEvent(new StorageEvent('storage'));
      } catch (err: unknown) {
        console.warn(
          '[useActiveImageModel]',
          `Failed to persist model preference: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    },
    [sequenceId]
  );

  return {
    activeModel,
    setActiveModel,
    availableModels,
    isLoading,
  };
}
