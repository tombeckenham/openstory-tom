/**
 * Hooks for team-level location library operations
 */

import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import {
  addLocationSheetsFn,
  createLibraryLocationFn,
  deleteLibraryLocationFn,
  deleteLocationSheetFn,
  getLibraryLocationByIdFn,
  getPublicLibraryLocationByIdFn,
  presignLocationUploadFn,
  finalizeLocationUploadFn,
  updateLibraryLocationFn,
} from '@/functions/location-library';
import { useSession } from '@/lib/auth/client';
import { putToR2 } from '@/lib/utils/upload';
import {
  libraryLocationKeys,
  sequenceLocationKeys,
} from '@/hooks/use-sequence-locations';
import type { LibraryLocation, LocationSheet } from '@/lib/db/schema';

/** Library location with sheets for detail view */
export type LibraryLocationWithSheets = LibraryLocation & {
  sequenceTitle: string; // For backwards compatibility - always 'Library' for library locations
  sheets: LocationSheet[];
};

/**
 * Query keys for location library
 */
export const locationLibraryKeys = {
  all: ['location-library'] as const,
  detail: (id: string) => [...locationLibraryKeys.all, 'detail', id] as const,
};

/**
 * Invalidate all location-related queries.
 * Use after mutations that affect location data.
 */
function invalidateLocationQueries(
  queryClient: QueryClient,
  locationId?: string
): void {
  if (locationId) {
    void queryClient.invalidateQueries({
      queryKey: locationLibraryKeys.detail(locationId),
    });
  }
  void queryClient.invalidateQueries({ queryKey: libraryLocationKeys.all });
  void queryClient.invalidateQueries({
    queryKey: sequenceLocationKeys.teamLibrary,
  });
}

/**
 * Hook to fetch a single location with details and reference sheets. Anonymous
 * visitors get the public ("system") location so they can open a location
 * detail page read-only.
 */
export function useLibraryLocationById(locationId: string) {
  // Only a *settled* null session counts as anonymous — while the session is
  // loading we wait, and a failed session lookup surfaces as a query error.
  const { data: session, isPending, error: sessionError } = useSession();
  const isAuthenticated = !!session;
  return useQuery<LibraryLocationWithSheets>({
    queryKey: locationLibraryKeys.detail(locationId),
    queryFn: () => {
      if (sessionError) {
        throw new Error(`Failed to fetch session: ${sessionError.message}`, {
          cause: sessionError,
        });
      }
      return isAuthenticated
        ? getLibraryLocationByIdFn({ data: { locationId } })
        : getPublicLibraryLocationByIdFn({ data: { locationId } });
    },
    enabled: !!locationId && !isPending,
  });
}

/**
 * Hook to create a new library location
 */
export function useCreateLibraryLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      name: string;
      description?: string;
      referenceImageUrls?: string[];
    }) => createLibraryLocationFn({ data }),
    onSuccess: () => invalidateLocationQueries(queryClient),
  });
}

/**
 * Hook to update a library location
 */
export function useUpdateLibraryLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      locationId: string;
      name?: string;
      description?: string;
      referenceImageUrl?: string;
    }) => updateLibraryLocationFn({ data }),
    onSuccess: (_, variables) =>
      invalidateLocationQueries(queryClient, variables.locationId),
  });
}

/**
 * Hook to delete a library location
 */
export function useDeleteLibraryLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (locationId: string) =>
      deleteLibraryLocationFn({ data: { locationId } }),
    onSuccess: () => invalidateLocationQueries(queryClient),
  });
}

/**
 * Hook to upload location media via presigned URL
 */
export function useUploadLocationMedia() {
  return useMutation({
    mutationFn: async (data: {
      file: File;
      locationId?: string;
      onProgress?: (percent: number) => void;
    }) => {
      // 1. Get presigned URL from server
      const presign = await presignLocationUploadFn({
        data: {
          filename: data.file.name,
          locationId: data.locationId,
        },
      });

      // 2. Upload directly to R2
      await putToR2(
        presign.uploadUrl,
        data.file,
        presign.contentType,
        data.onProgress
      );

      // 3. Finalize: update DB record if uploading to an existing location
      if (data.locationId) {
        await finalizeLocationUploadFn({
          data: {
            locationId: data.locationId,
            publicUrl: presign.publicUrl,
            path: presign.path,
          },
        });
      }

      return { url: presign.publicUrl, path: presign.path };
    },
  });
}

/**
 * Hook to add reference images to an existing location
 */
export function useAddLocationSheets() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { locationId: string; imageUrls: string[] }) =>
      addLocationSheetsFn({ data }),
    onSuccess: (_, variables) =>
      invalidateLocationQueries(queryClient, variables.locationId),
  });
}

/**
 * Hook to delete a reference image from a location
 */
export function useDeleteLocationSheet() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: { sheetId: string; locationId: string }) =>
      deleteLocationSheetFn({ data: { sheetId: data.sheetId } }),
    onSuccess: (_, variables) =>
      invalidateLocationQueries(queryClient, variables.locationId),
  });
}
