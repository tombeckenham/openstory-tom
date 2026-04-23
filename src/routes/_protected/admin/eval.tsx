import { EvalView } from '@/components/eval/eval-view';
import { PageContainer } from '@/components/layout/page-container';
import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';

const searchSchema = z.object({
  user: z.string().email().optional(),
});

export const Route = createFileRoute('/_protected/admin/eval')({
  validateSearch: searchSchema,
  component: EvalPage,
  staticData: { breadcrumb: 'Eval' },
});

function EvalPage() {
  const { user } = Route.useSearch();
  return (
    <div className="h-full overflow-hidden flex flex-col">
      <PageContainer
        maxWidth="full"
        className="flex-1 flex flex-col overflow-hidden"
      >
        <EvalView initialUserFilter={user} />
      </PageContainer>
    </div>
  );
}
