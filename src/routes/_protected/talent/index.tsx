import { useAuthGate } from '@/components/auth/auth-gate-provider';
import { AddTalentDialog } from '@/components/talent-library/add-talent-dialog';
import { TalentLibraryFilters } from '@/components/talent-library/talent-library-filters';
import { TalentLibraryList } from '@/components/talent-library/talent-library-list';
import { PageContainer } from '@/components/layout/page-container';
import { PageDescription } from '@/components/typography/page-description';
import { PageHeader } from '@/components/typography/page-header';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { useTalent } from '@/hooks/use-talent';
import { createFileRoute } from '@tanstack/react-router';
import { Plus, User } from 'lucide-react';
import { z } from 'zod';

const searchParamsSchema = z.object({
  filter: z.enum(['all', 'favorites']).optional().default('all'),
});

export const Route = createFileRoute('/_protected/talent/')({
  validateSearch: searchParamsSchema,
  component: TalentPage,
  staticData: { breadcrumb: 'Talent' },
});

function TalentPage() {
  const { filter } = Route.useSearch();
  const { isAuthenticated, openLogin } = useAuthGate();
  const {
    data: talent,
    isLoading,
    error,
  } = useTalent({
    favoritesOnly: filter === 'favorites',
  });

  // Anonymous visitors browse the public ("system") talent catalogue; creating
  // talent prompts a login.
  const addAction = isAuthenticated ? (
    <AddTalentDialog />
  ) : (
    <Button onClick={openLogin}>
      <Plus className="mr-2 h-4 w-4" />
      Add Talent
    </Button>
  );

  return (
    <div className="h-full overflow-auto">
      <PageContainer>
        <h1 className="sr-only">Talent Library</h1>
        <PageHeader actions={addAction}>
          <PageDescription>
            {isAuthenticated
              ? "Manage your team's talent library for consistent AI-generated content."
              : 'Browse system talent. Sign in to add your own and keep characters consistent across sequences.'}
          </PageDescription>
        </PageHeader>

        {isAuthenticated && <TalentLibraryFilters currentFilter={filter} />}

        {!isLoading && talent && talent.length === 0 ? (
          <EmptyState
            icon={<User className="h-12 w-12" />}
            title={isAuthenticated ? 'No talent yet' : 'No system talent yet'}
            description={
              isAuthenticated
                ? 'Add talent to your library to maintain visual consistency across your sequences.'
                : 'Check back soon, or sign in to build your own talent library.'
            }
            action={addAction}
          />
        ) : (
          <TalentLibraryList
            talent={talent}
            isLoading={isLoading}
            error={error}
          />
        )}
      </PageContainer>
    </div>
  );
}
