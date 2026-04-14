import { getSequenceImageModelsFn } from '@/functions/frames';
import { useQuery } from '@tanstack/react-query';
import { useCallback, useSyncExternalStore } from 'react';

const STORAGE_KEY_PREFIX = 'openstory:active-image-model:';

function getStorageKey(sequenceId: string) {
  return `${STORAGE_KEY_PREFIX}${sequenceId}`;
}

function getSnapshot(sequenceId: string): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(getStorageKey(sequenceId));
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
      localStorage.setItem(getStorageKey(sequenceId), model);
      // Dispatch storage event for cross-tab sync
      window.dispatchEvent(new StorageEvent('storage'));
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
