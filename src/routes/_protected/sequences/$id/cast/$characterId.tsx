import { CharacterDetailView } from '@/components/talent/character-detail-view';
import { useSequenceCharacters } from '@/hooks/use-sequence-characters';
import { createFileRoute } from '@tanstack/react-router';

function CharacterCrumbLabel({
  sequenceId,
  characterId,
}: {
  sequenceId: string;
  characterId: string;
}) {
  const { data: characters } = useSequenceCharacters(sequenceId);
  const character = characters?.find((c) => c.id === characterId);
  return <>{character?.name ?? '…'}</>;
}

export const Route = createFileRoute(
  '/_protected/sequences/$id/cast/$characterId'
)({
  component: CharacterDetailPage,
  staticData: {
    breadcrumb: (match) => {
      const params: { id: string; characterId: string } = match.params;
      return {
        label: (
          <CharacterCrumbLabel
            sequenceId={params.id}
            characterId={params.characterId}
          />
        ),
      };
    },
  },
});

function CharacterDetailPage() {
  const { id: sequenceId, characterId } = Route.useParams();

  return (
    <CharacterDetailView sequenceId={sequenceId} characterId={characterId} />
  );
}
