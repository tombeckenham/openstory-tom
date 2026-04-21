import {
  deleteSequenceElementFn,
  finalizeElementUploadFn,
  listSequenceElementsFn,
  presignElementUploadFn,
  renameSequenceElementTokenFn,
} from '@/functions/sequence-elements';
import type { SequenceElement } from '@/lib/db/schema';
import { putToR2 } from '@/lib/utils/upload';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

export const sequenceElementKeys = {
  all: ['sequence-elements'] as const,
  bySequence: (sequenceId: string) =>
    ['sequence-elements', sequenceId] as const,
};

export function useSequenceElements(sequenceId: string | undefined) {
  return useQuery({
    queryKey: sequenceId
      ? sequenceElementKeys.bySequence(sequenceId)
      : ['sequence-elements', 'none'],
    queryFn: () =>
      listSequenceElementsFn({ data: { sequenceId: sequenceId ?? '' } }),
    enabled: Boolean(sequenceId),
    // Poll while vision is still analyzing
    refetchInterval: (query) => {
      const data = query.state.data as SequenceElement[] | undefined;
      if (!data) return false;
      const hasPending = data.some(
        (el) => el.visionStatus === 'pending' || el.visionStatus === 'analyzing'
      );
      return hasPending ? 2000 : false;
    },
  });
}

/**
 * Upload an element file into an existing sequence: presign → R2 → finalize.
 */
export function useUploadElementToSequence() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (data: {
      file: File;
      sequenceId: string;
      onProgress?: (percent: number) => void;
    }) => {
      const presign = await presignElementUploadFn({
        data: { filename: data.file.name, sequenceId: data.sequenceId },
      });
      await putToR2(
        presign.uploadUrl,
        data.file,
        presign.contentType,
        data.onProgress
      );
      const element = await finalizeElementUploadFn({
        data: {
          sequenceId: data.sequenceId,
          publicUrl: presign.publicUrl,
          path: presign.path,
          filename: data.file.name,
        },
      });
      return element;
    },
    onSuccess: (_element, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.bySequence(variables.sequenceId),
      });
    },
  });
}

export type DraftElementUpload = {
  tempPath: string;
  tempPublicUrl: string;
  filename: string;
  token: string;
};

/**
 * Upload an element file as a *draft* (before a sequence exists). Returns the
 * temp storage path + public URL so the caller can persist it in local state
 * and pass it to the createSequence mutation for promotion.
 */
export function useUploadDraftElement() {
  return useMutation({
    mutationFn: async (data: {
      file: File;
      onProgress?: (percent: number) => void;
    }): Promise<DraftElementUpload> => {
      const presign = await presignElementUploadFn({
        data: { filename: data.file.name },
      });
      await putToR2(
        presign.uploadUrl,
        data.file,
        presign.contentType,
        data.onProgress
      );
      const token = data.file.name
        .replace(/\.[^.]+$/, '')
        .toUpperCase()
        .replace(/[^A-Z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
      return {
        tempPath: presign.path,
        tempPublicUrl: presign.publicUrl,
        filename: data.file.name,
        token: token.length > 0 ? token : 'ELEMENT',
      };
    },
  });
}

export function useDeleteSequenceElement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: { elementId: string; sequenceId: string }) =>
      deleteSequenceElementFn({ data }),
    onSuccess: (_res, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.bySequence(variables.sequenceId),
      });
    },
  });
}

export function useRenameSequenceElementToken() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (data: {
      elementId: string;
      sequenceId: string;
      token: string;
    }) => renameSequenceElementTokenFn({ data }),
    onSuccess: (_res, variables) => {
      void queryClient.invalidateQueries({
        queryKey: sequenceElementKeys.bySequence(variables.sequenceId),
      });
    },
  });
}
