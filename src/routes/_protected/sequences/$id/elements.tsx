import { ElementsView } from '@/components/element/elements-view';
import { createFileRoute } from '@tanstack/react-router';

export const Route = createFileRoute('/_protected/sequences/$id/elements')({
  component: ElementsPage,
});

function ElementsPage() {
  const { id: sequenceId } = Route.useParams();
  return <ElementsView sequenceId={sequenceId} />;
}
