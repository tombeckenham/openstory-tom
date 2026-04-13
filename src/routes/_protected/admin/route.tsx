import { RouteErrorFallback } from '@/components/error/route-error-fallback';
import { isSystemAdminFn } from '@/functions/gift-tokens';
import { createFileRoute, Outlet, redirect } from '@tanstack/react-router';

export const Route = createFileRoute('/_protected/admin')({
  beforeLoad: async () => {
    const { isAdmin } = await isSystemAdminFn();
    if (!isAdmin) {
      throw redirect({ to: '/sequences' });
    }
  },
  component: AdminLayout,
  errorComponent: (props) => (
    <RouteErrorFallback {...props} heading="Admin error" />
  ),
});

function AdminLayout() {
  return (
    <div className="mx-auto w-full max-w-6xl p-6">
      <Outlet />
    </div>
  );
}
