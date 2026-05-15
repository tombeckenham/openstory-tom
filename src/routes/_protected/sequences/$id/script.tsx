import { ScriptView } from '@/components/script/script-view';
import { useSequence } from '@/hooks/use-sequences';
import { createFileRoute, useNavigate } from '@tanstack/react-router';

export const Route = createFileRoute('/_protected/sequences/$id/script')({
  component: ScriptPage,
  staticData: { breadcrumb: 'Script' },
});

function ScriptPage() {
  const { id: sequenceId } = Route.useParams();
  const navigate = useNavigate();

  const { data: sequence, isLoading: isLoadingSequence } =
    useSequence(sequenceId);

  const handleSuccess = (sequenceIds: string[]) => {
    const [firstId] = sequenceIds;
    if (firstId) {
      void navigate({
        to: '/sequences/$id/scenes',
        params: { id: firstId },
      });
    }
  };

  return (
    <div className="h-full px-6 py-4" data-testid="edit-script-page">
      <ScriptView
        onSuccess={handleSuccess}
        sequence={sequence}
        loading={isLoadingSequence || !sequence}
        flat
      />
    </div>
  );
}
