/**
 * Billing Gate Dialog
 * Promotes BYOK first: enter a fal.ai key inline or connect OpenRouter via
 * OAuth, with credits below and gift codes at the bottom. A fal key alone
 * covers everything — LLM calls route through fal's OpenRouter endpoint.
 */

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { FalLogo } from '@/components/icons/fal-logo';
import { OpenRouterLogo } from '@/components/icons/openrouter-logo';
import { saveApiKeyFn } from '@/functions/api-keys';
import { initiateOpenRouterOAuthFn } from '@/functions/openrouter-oauth';
import { getCurrentUserProfileFn } from '@/functions/user';
import { BILLING_GATE_KEY } from '@/hooks/use-billing-gate';
import { cn } from '@/lib/utils';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import {
  ArrowRight,
  Check,
  CreditCard,
  ExternalLink,
  Gift,
} from 'lucide-react';
import { useState } from 'react';

const RETURN_KEY = 'openstory:billing-return';

function setReturnPath(returnTo?: string) {
  const path =
    returnTo ??
    (typeof window !== 'undefined' ? window.location.pathname : '/');
  localStorage.setItem(RETURN_KEY, path);
}

type OptionCardProps = {
  to?: string;
  search?: Record<string, string>;
  icon: React.ReactNode;
  title: string;
  description: string;
  variant?: 'primary' | 'muted';
  onClick?: () => void;
};

const cardClassName = (variant: 'primary' | 'muted') =>
  cn(
    'group relative flex items-center gap-3.5 rounded-xl border p-3.5 transition-all duration-200',
    variant === 'primary' &&
      'border-primary/20 bg-primary/[0.03] hover:border-primary/40 hover:bg-primary/[0.06]',
    variant === 'muted' &&
      'border-border/60 bg-transparent hover:border-border hover:bg-accent/50'
  );

const OptionCard: React.FC<OptionCardProps> = ({
  to,
  search,
  icon,
  title,
  description,
  variant = 'muted',
  onClick,
}) => (
  <Link to={to ?? '/'} search={search} onClick={onClick}>
    <div className={cardClassName(variant)}>
      <div
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-lg transition-colors duration-200',
          variant === 'primary' &&
            'bg-primary/10 text-primary group-hover:bg-primary/15',
          variant === 'muted' &&
            'bg-muted text-muted-foreground group-hover:bg-muted/80'
        )}
      >
        {icon}
      </div>
      <div className="flex-1 space-y-0.5">
        <span className="text-sm font-medium">{title}</span>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
      <ArrowRight
        className={cn(
          'size-3.5 shrink-0 -translate-x-1 opacity-0 transition-all duration-200 group-hover:translate-x-0 group-hover:opacity-60',
          variant === 'muted' && 'text-muted-foreground'
        )}
      />
    </div>
  </Link>
);

const ConnectedBadge: React.FC = () => (
  <Badge variant="default" className="gap-1 px-1.5 py-0 text-[10px]">
    <Check className="size-2.5" />
    Connected
  </Badge>
);

type ProviderCardProps = {
  logo: React.ReactNode;
  title: string;
  description: string;
  connected: boolean;
  children?: React.ReactNode;
};

const ProviderCard: React.FC<ProviderCardProps> = ({
  logo,
  title,
  description,
  connected,
  children,
}) => (
  <div className="flex flex-col gap-2.5 rounded-xl border border-border/60 p-3.5">
    <div className="flex items-center gap-3.5">
      <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted text-foreground">
        {logo}
      </div>
      <div className="flex-1 space-y-0.5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">{title}</span>
          {connected && <ConnectedBadge />}
        </div>
        <p className="text-xs text-muted-foreground">{description}</p>
      </div>
    </div>
    {!connected && children}
  </div>
);

type BillingGateDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  hasFalKey?: boolean;
  hasOpenRouterKey?: boolean;
  stripeEnabled?: boolean;
  returnTo?: string;
  context?: 'generation' | 'onboarding';
};

export const BillingGateDialog: React.FC<BillingGateDialogProps> = ({
  open,
  onOpenChange,
  hasFalKey = false,
  hasOpenRouterKey = false,
  stripeEnabled = true,
  returnTo,
  context = 'generation',
}) => {
  const queryClient = useQueryClient();
  const posthog = usePostHog();
  const [falKeyInput, setFalKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);

  const { data: profile } = useQuery({
    queryKey: ['currentUserProfile'],
    queryFn: () => getCurrentUserProfileFn(),
    staleTime: 5 * 60 * 1000,
    enabled: open,
  });
  const teamId = profile?.teamId;

  const saveFalKeyMutation = useMutation({
    mutationFn: (apiKey: string) => {
      if (!teamId) throw new Error('No team found');
      return saveApiKeyFn({ data: { teamId, provider: 'fal', apiKey } });
    },
    onSuccess: () => {
      setFalKeyInput('');
      setError(null);
      posthog.capture('api_key_saved', {
        provider: 'fal',
        source: 'billing_gate',
      });
      void queryClient.invalidateQueries({ queryKey: [...BILLING_GATE_KEY] });
      void queryClient.invalidateQueries({ queryKey: ['apiKeys', teamId] });
      void queryClient.invalidateQueries({
        queryKey: ['apiKeyStatus', teamId],
      });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    },
  });

  const oauthMutation = useMutation({
    mutationFn: () => {
      if (!teamId) throw new Error('No team found');
      return initiateOpenRouterOAuthFn({ data: { teamId } });
    },
    onSuccess: (data) => {
      // OAuth leaves the page — remember where to send the user afterwards.
      setReturnPath(returnTo);
      posthog.capture('openrouter_oauth_started', { source: 'billing_gate' });
      window.location.href = data.authUrl;
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to start OAuth');
    },
  });

  const handleSaveFalKey = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!falKeyInput.trim()) return;
    saveFalKeyMutation.mutate(falKeyInput.trim());
  };

  const handleNav = () => {
    setReturnPath(returnTo);
    onOpenChange(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-md"
        showCloseButton={false}
        onInteractOutside={(e) => e.preventDefault()}
        onEscapeKeyDown={(e) => e.preventDefault()}
      >
        <DialogHeader>
          <DialogTitle>
            {context === 'onboarding'
              ? 'Get started with OpenStory'
              : 'Set up billing to continue'}
          </DialogTitle>
          <DialogDescription>
            {context === 'onboarding'
              ? 'Connect your own API keys or add credits to start creating.'
              : 'This action uses AI credits. Connect your own keys or add credits.'}
          </DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-2 pt-1">
          <ProviderCard
            logo={<FalLogo className="size-5" />}
            title="fal.ai"
            description="One key covers everything — images, video, audio, and script analysis."
            connected={hasFalKey}
          >
            <form onSubmit={handleSaveFalKey} className="flex gap-2">
              <Input
                name="falKey"
                type="password"
                placeholder="fal_…"
                value={falKeyInput}
                onChange={(e) => setFalKeyInput(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label="fal.ai API key"
                required
              />
              <Button
                type="submit"
                disabled={saveFalKeyMutation.isPending || !falKeyInput.trim()}
              >
                {saveFalKeyMutation.isPending ? 'Saving…' : 'Save'}
              </Button>
            </form>
            <a
              href="https://fal.ai/dashboard/keys"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 transition-colors hover:text-foreground hover:underline"
            >
              Get a key from fal.ai
              <ExternalLink className="size-3" />
            </a>
          </ProviderCard>

          <ProviderCard
            logo={<OpenRouterLogo className="size-5" />}
            title="OpenRouter"
            description="Optional — use your own OpenRouter account for script analysis."
            connected={hasOpenRouterKey}
          >
            <Button
              variant="outline"
              onClick={() => oauthMutation.mutate()}
              disabled={oauthMutation.isPending}
              className="w-full"
            >
              <ExternalLink className="mr-2 size-4" />
              {oauthMutation.isPending
                ? 'Connecting…'
                : 'Connect with OpenRouter'}
            </Button>
          </ProviderCard>

          {error && (
            <p role="alert" className="text-xs text-destructive">
              {error}
            </p>
          )}

          {stripeEnabled && (
            <>
              <div className="flex items-center gap-3 py-1">
                <Separator className="flex-1" />
                <span className="text-[11px] font-medium uppercase tracking-widest text-muted-foreground/50">
                  or
                </span>
                <Separator className="flex-1" />
              </div>

              <OptionCard
                to="/credits"
                icon={<CreditCard className="size-4" />}
                title="Buy Credits"
                description="Pay as you go. Auto top-up keeps you generating."
                variant="primary"
                onClick={handleNav}
              />
            </>
          )}
        </div>

        <div className="flex items-center justify-between pt-1">
          <Link
            to="/credits"
            search={{ tab: 'gift-codes' }}
            onClick={handleNav}
            className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/70 transition-colors hover:text-muted-foreground"
          >
            <Gift className="size-3.5" />
            Redeem a gift code
          </Link>
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground/70 hover:text-muted-foreground"
            onClick={() => onOpenChange(false)}
          >
            {hasFalKey ? 'Continue' : 'Set up later'}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};
