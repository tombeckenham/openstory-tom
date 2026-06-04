/**
 * Hook for fetching sequence locations
 */

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  getFrameIdsForLocationFn,
  getSequenceLocationsFn,
  getTeamLocationsLibraryFn,
  recastLocationFn,
} from '@/functions/sequence-locations';
import {
  getPublicLibraryLocationsFn,
  getTeamLibraryLocationsFn,
} from '@/functions/location-library';
import { useSession } from '@/lib/auth/client';
import type { LibraryLocation, SequenceLocation } from '@/lib/db/schema';

// Re-export for backwards compatibility
export type { SequenceLocation };
export type { LibraryLocation };

// Extended type for team library locations (sequence locations with title)
export type TeamSequenceLocation = SequenceLocation & { sequenceTitle: string };

// Backwards compatibility alias
export type TeamLibraryLocation = TeamSequenceLocation;

// Extended type for display (used in location library page)
export type DisplayLocation = {
  id: string;
  name: string;
  description: string | null;
  type?: string | null;
  referenceImageUrl: string | null;
  sequenceTitle?: string;
  source?: 'library' | 'sequence';
};

export const sequenceLocationKeys = {
  all: ['sequence-locations'] as const,
  list: (sequenceId: string) =>
    [...sequenceLocationKeys.all, 'list', sequenceId] as const,
  framesForLocation: (sequenceId: string, locationId: string) =>
    [...sequenceLocationKeys.all, 'frames', sequenceId, locationId] as const,
  teamLibrary: ['team-locations-library'] as const,
};

export const libraryLocationKeys = {
  all: ['library-locations'] as const,
  list: ['library-locations', 'list'] as const,
  publicList: ['library-locations', 'list', 'public'] as const,
};

export function useSequenceLocations(sequenceId: string) {
  return useQuery<SequenceLocation[]>({
    queryKey: sequenceLocationKeys.list(sequenceId),
    queryFn: async () => {
      return getSequenceLocationsFn({ data: { sequenceId } });
    },
    staleTime: 5 * 60 * 1000, // 5 minutes - locations don't change often
    enabled: !!sequenceId,
  });
}

/**
 * Hook to get all sequence locations with completed references across the team
 * Used for recasting locations
 */
export function useTeamSequenceLocations() {
  return useQuery<TeamSequenceLocation[]>({
    queryKey: sequenceLocationKeys.teamLibrary,
    queryFn: async () => {
      return getTeamLocationsLibraryFn();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Hook to get all library locations for the team
 * These are user-created location templates
 */
export function useLibraryLocations() {
  // Authenticated users get their team's locations plus public ("system")
  // ones; anonymous visitors get the public catalogue so they can browse and
  // pick system locations on the public new-sequence screen and locations page.
  const { data: session } = useSession();
  const isAuthenticated = !!session;
  return useQuery<LibraryLocation[]>({
    queryKey: isAuthenticated
      ? libraryLocationKeys.list
      : libraryLocationKeys.publicList,
    queryFn: async () => {
      return isAuthenticated
        ? getTeamLibraryLocationsFn()
        : getPublicLibraryLocationsFn();
    },
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Combined hook for location library page
 * Returns both library locations and sequence locations merged
 */
export function useAllLocations() {
  const libraryQuery = useLibraryLocations();
  const sequenceQuery = useTeamSequenceLocations();

  const isLoading = libraryQuery.isLoading || sequenceQuery.isLoading;
  const error = libraryQuery.error || sequenceQuery.error;

  // Merge and normalize both sources into DisplayLocation format
  const locations: DisplayLocation[] = [];

  // Add library locations
  if (libraryQuery.data) {
    for (const loc of libraryQuery.data) {
      locations.push({
        id: loc.id,
        name: loc.name,
        description: loc.description,
        type: null, // Library locations don't have type
        referenceImageUrl: loc.referenceImageUrl,
        sequenceTitle: 'Library',
        source: 'library',
      });
    }
  }

  // Add sequence locations
  if (sequenceQuery.data) {
    for (const loc of sequenceQuery.data) {
      locations.push({
        id: loc.id,
        name: loc.name,
        description: loc.description,
        type: loc.type,
        referenceImageUrl: loc.referenceImageUrl,
        sequenceTitle: loc.sequenceTitle,
        source: 'sequence',
      });
    }
  }

  return {
    data: locations.length > 0 ? locations : undefined,
    isLoading,
    error,
  };
}

// Backwards compatibility alias
export const useTeamLocationsLibrary = useTeamSequenceLocations;

/**
 * Hook to get the count of frames at a location
 * Used to show affected frames before recasting
 */
export function useFrameIdsForLocation(sequenceId: string, locationId: string) {
  return useQuery({
    queryKey: sequenceLocationKeys.framesForLocation(sequenceId, locationId),
    queryFn: () =>
      getFrameIdsForLocationFn({ data: { sequenceId, locationId } }),
    enabled: !!sequenceId && !!locationId,
    staleTime: 60 * 1000, // 1 minute
  });
}

/**
 * Hook for recasting a location with a library location reference
 */
export function useRecastLocation() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (data: {
      locationId: string;
      libraryLocationId: string;
      referenceImageUrl: string;
      description?: string;
    }) => recastLocationFn({ data }),
    onSuccess: () => {
      // Invalidate sequence locations to refresh the list
      void queryClient.invalidateQueries({
        queryKey: sequenceLocationKeys.all,
      });
      // Invalidate frames that are at this location
      void queryClient.invalidateQueries({ queryKey: ['frames'] });
    },
  });
}
