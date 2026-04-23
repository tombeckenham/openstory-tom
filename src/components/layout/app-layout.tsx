import { cn } from '@/lib/utils';
import {
  SidebarInset,
  SidebarProvider,
  SidebarTrigger,
} from '@/components/ui/sidebar';
import type * as React from 'react';
import { AppSidebar } from './app-sidebar';
import { InvalidApiKeyBanner } from './invalid-api-key-banner';

interface AppLayoutProps extends React.HTMLAttributes<HTMLElement> {}

export const AppLayout: React.FC<AppLayoutProps> = ({
  className,
  children,
  ...props
}) => {
  return (
    <SidebarProvider>
      <AppSidebar />
      <SidebarInset>
        <header className="flex h-12 shrink-0 items-center gap-2 border-b px-4">
          <SidebarTrigger />
        </header>
        <InvalidApiKeyBanner />
        <main
          className={cn(
            'flex flex-col flex-1 overflow-y-auto [scrollbar-gutter:stable]',
            className
          )}
          {...props}
        >
          {children}
        </main>
      </SidebarInset>
    </SidebarProvider>
  );
};
