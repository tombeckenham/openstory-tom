import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import { ModelBadge } from '@/components/model/model-badge';
import { SequenceAudioModelSelector } from '@/components/model/sequence-audio-model-selector';
import { SequenceImageModelSelector } from '@/components/model/sequence-image-model-selector';
import { SequenceVideoModelSelector } from '@/components/model/sequence-video-model-selector';
import { routeParams } from '@/components/layout/breadcrumbs';
import {
  SequenceTabs,
  getDefaultSequenceTabPath,
  useSequenceTabItems,
} from '@/components/sequence/sequence-tabs';
import { PageHeader } from '@/components/typography/page-header';
import { getSequenceFn } from '@/functions/sequences';
import { sequenceKeys, useSequence } from '@/hooks/use-sequences';
import { useSwipeNavigation } from '@/hooks/use-swipe-navigation';
import { useUser } from '@/hooks/use-user';
import { requireSessionOrRedirect } from '@/lib/auth/route-guards';
import { isValidId } from '@/lib/db/id';
import {
  createFileRoute,
  notFound,
  Outlet,
  useRouterState,
} from '@tanstack/react-router';

function SequenceCrumbLabel({ id }: { id: string }) {
  const { data } = useSequence(id);
  return <>{data?.title ?? '…'}</>;
}

export const Route = createFileRoute('/_app/sequences/$id')({
  component: SequenceLayout,
  beforeLoad: async ({ context: { queryClient }, location }) => {
    await requireSessionOrRedirect(queryClient, location.href);
  },
  loader: async ({ params, context: { queryClient } }) => {
    if (!isValidId(params.id)) {
      throw notFound();
    }

    await queryClient.ensureQueryData({
      queryKey: sequenceKeys.detail(params.id),
      queryFn: () => getSequenceFn({ data: { sequenceId: params.id } }),
    });
  },
  staticData: {
    breadcrumb: (match) => {
      const { id } = routeParams<{ id: string }>(match);
      return [
        { label: 'Sequences', to: '/sequences' },
        {
          label: <SequenceCrumbLabel id={id} />,
          to: getDefaultSequenceTabPath(id),
        },
      ];
    },
  },
  errorComponent: (props) => (
    <RouteErrorFallback {...props} heading="Sequence error" />
  ),
});

function SequenceLayout() {
  const { id: sequenceId } = Route.useParams();

  useUser();

  const { data: sequence } = useSequence(sequenceId);

  const tabs = useSequenceTabItems(sequenceId);
  const currentPath = useRouterState({
    select: (s) => s.location.pathname,
  });
  const { onTouchStart, onTouchEnd } = useSwipeNavigation({
    routes: tabs.map((t) => t.href),
    currentRoute: currentPath,
  });

  return (
    <div className="flex h-full flex-col">
      <div className="mx-auto w-full max-w-[1920px] shrink-0 space-y-1 px-6 pt-4">
        <h1 className="sr-only">{sequence?.title ?? 'Sequence'}</h1>
        <PageHeader>
          <div className="hidden md:flex flex-row flex-wrap items-center gap-2">
            <ModelBadge model={sequence?.analysisModel} />
            <SequenceImageModelSelector
              sequenceId={sequenceId}
              sequenceImageModel={sequence?.imageModel}
            />
            <SequenceVideoModelSelector
              sequenceId={sequenceId}
              sequenceVideoModel={sequence?.videoModel}
            />
            <SequenceAudioModelSelector
              sequenceId={sequenceId}
              sequenceMusicModel={sequence?.musicModel}
            />
          </div>
        </PageHeader>
        <SequenceTabs sequenceId={sequenceId} />
      </div>
      <div
        className="mx-auto w-full max-w-[1920px] flex-1 min-h-0 overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchEnd={onTouchEnd}
      >
        <Outlet />
      </div>
    </div>
  );
}
