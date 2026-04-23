import { LocationDetailView } from '@/components/locations/location-detail-view';
import { useSequenceLocations } from '@/hooks/use-sequence-locations';
import { createFileRoute } from '@tanstack/react-router';

function LocationCrumbLabel({
  sequenceId,
  locationId,
}: {
  sequenceId: string;
  locationId: string;
}) {
  const { data: locations } = useSequenceLocations(sequenceId);
  const location = locations?.find((l) => l.id === locationId);
  return <>{location?.name ?? '…'}</>;
}

export const Route = createFileRoute(
  '/_protected/sequences/$id/locations/$locationId'
)({
  component: LocationDetailPage,
  staticData: {
    breadcrumb: (match) => {
      const params: { id: string; locationId: string } = match.params;
      return {
        label: (
          <LocationCrumbLabel
            sequenceId={params.id}
            locationId={params.locationId}
          />
        ),
      };
    },
  },
});

function LocationDetailPage() {
  const { id: sequenceId, locationId } = Route.useParams();

  return <LocationDetailView sequenceId={sequenceId} locationId={locationId} />;
}
