/**
 * API Key Settings Component
 * Manages BYOK (Bring Your Own Key) for OpenRouter and Fal.ai
 */

import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card';
import { FalLogo } from '@/components/icons/fal-logo';
import { OpenRouterLogo } from '@/components/icons/openrouter-logo';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import {
  checkApiKeyStatusFn,
  deleteApiKeyFn,
  listApiKeysFn,
  revalidateApiKeyFn,
  saveApiKeyFn,
} from '@/functions/api-keys';
import { initiateOpenRouterOAuthFn } from '@/functions/openrouter-oauth';
import { getCurrentUserProfileFn } from '@/functions/user';
import { BILLING_GATE_KEY } from '@/hooks/use-billing-gate';
import { usePostHog } from '@posthog/react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@tanstack/react-router';
import { AlertTriangle, ExternalLink, RotateCcw, Trash2 } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type ApiKeySettingsProps = {
  success?: string;
  error?: string;
};

export function ApiKeySettings(props: ApiKeySettingsProps) {
  const { data: profile } = useQuery({
    queryKey: ['currentUserProfile'],
    queryFn: () => getCurrentUserProfileFn(),
    staleTime: 5 * 60 * 1000,
  });

  if (!profile?.teamId) {
    return <ApiKeySettingsLoading />;
  }

  return <ApiKeySettingsContent teamId={profile.teamId} {...props} />;
}

function ApiKeySettingsLoading() {
  return (
    <Card>
      <CardHeader>
        <Skeleton className="h-10 w-48" />
      </CardHeader>
      <CardContent className="space-y-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </CardContent>
    </Card>
  );
}

const RETURN_KEY = 'openstory:billing-return';

function ApiKeySettingsContent({
  teamId,
  success,
  error: urlError,
}: ApiKeySettingsProps & { teamId: string }) {
  const queryClient = useQueryClient();
  const posthog = usePostHog();
  const [falKeyInput, setFalKeyInput] = useState('');
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();
  const hasShownToastRef = useRef(false);

  const { data: apiKeys, isLoading: keysLoading } = useQuery({
    queryKey: ['apiKeys', teamId],
    queryFn: () => listApiKeysFn({ data: { teamId } }),
    staleTime: 5 * 60 * 1000,
  });

  const { data: keyStatus, isLoading: statusLoading } = useQuery({
    queryKey: ['apiKeyStatus', teamId],
    queryFn: () => checkApiKeyStatusFn({ data: { teamId } }),
    staleTime: 5 * 60 * 1000,
  });

  // Show toast once generation is covered and there's a return path. A fal
  // key alone is enough — LLM calls route through fal's OpenRouter endpoint.
  useEffect(() => {
    if (hasShownToastRef.current) return;
    if (keyStatus?.fal !== 'team') return;
    const returnTo = localStorage.getItem(RETURN_KEY);
    if (!returnTo) return;

    hasShownToastRef.current = true;
    localStorage.removeItem(RETURN_KEY);
    toast.success('API keys configured', {
      description:
        keyStatus.openrouter === 'team'
          ? 'Both fal.ai and OpenRouter are connected.'
          : 'fal.ai is connected — that covers everything.',
      action: {
        label: 'Continue creating',
        onClick: () => void navigate({ to: returnTo }),
      },
      duration: 15_000,
    });
  }, [keyStatus, navigate]);

  const invalidateKeys = () => {
    void queryClient.invalidateQueries({ queryKey: ['apiKeys', teamId] });
    void queryClient.invalidateQueries({ queryKey: ['apiKeyStatus', teamId] });
    void queryClient.invalidateQueries({ queryKey: [...BILLING_GATE_KEY] });
  };

  const saveFalKeyMutation = useMutation({
    mutationFn: (apiKey: string) =>
      saveApiKeyFn({ data: { teamId, provider: 'fal', apiKey } }),
    onSuccess: () => {
      invalidateKeys();
      setFalKeyInput('');
      setError(null);
      posthog.capture('api_key_saved', { provider: 'fal' });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to save key');
    },
  });

  const deleteMutation = useMutation({
    mutationFn: (provider: 'openrouter' | 'fal') =>
      deleteApiKeyFn({ data: { teamId, provider } }),
    onSuccess: (_, provider) => {
      invalidateKeys();
      setError(null);
      posthog.capture('api_key_deleted', { provider });
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to delete key');
    },
  });

  const oauthMutation = useMutation({
    mutationFn: () => initiateOpenRouterOAuthFn({ data: { teamId } }),
    onSuccess: (data) => {
      posthog.capture('openrouter_oauth_started');
      window.location.href = data.authUrl;
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to start OAuth');
    },
  });

  const revalidateMutation = useMutation({
    mutationFn: (provider: 'openrouter' | 'fal') =>
      revalidateApiKeyFn({ data: { teamId, provider } }),
    onSuccess: (result, provider) => {
      // Only announce recovery — a key that was already valid (e.g. just
      // connected via OAuth) shouldn't toast "valid again" on page mount.
      const wasInvalid =
        apiKeys?.find((k) => k.provider === provider)?.isInvalid ?? false;
      invalidateKeys();
      if (result.valid && wasInvalid) {
        toast.success('Key re-validated', {
          description: `Your ${provider === 'openrouter' ? 'OpenRouter' : 'Fal.ai'} key is valid again.`,
        });
      }
    },
    onError: (err) => {
      setError(err instanceof Error ? err.message : 'Failed to re-validate');
    },
  });

  const isLoading = keysLoading || statusLoading;

  const openrouterKey = apiKeys?.find((k) => k.provider === 'openrouter');
  const falKey = apiKeys?.find((k) => k.provider === 'fal');

  // Re-validate stored team keys on mount so opening the settings page
  // refreshes their validity without waiting for the next workflow failure.
  const revalidatedRef = useRef(false);
  useEffect(() => {
    if (revalidatedRef.current) return;
    if (!openrouterKey) return;
    revalidatedRef.current = true;
    revalidateMutation.mutate('openrouter');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openrouterKey?.id]);

  const handleSaveFalKey = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!falKeyInput.trim()) return;
    saveFalKeyMutation.mutate(falKeyInput.trim());
  };

  const successMessage =
    success === 'openrouter_connected'
      ? 'OpenRouter connected successfully.'
      : null;

  const errorMessage =
    urlError === 'openrouter_oauth_missing_code'
      ? 'OAuth failed: missing authorization code.'
      : urlError === 'openrouter_oauth_no_team'
        ? 'OAuth failed: no team found.'
        : urlError === 'openrouter_oauth_failed'
          ? 'OAuth failed: could not connect to OpenRouter.'
          : null;

  return (
    <div className="space-y-6">
      {successMessage && (
        <Alert>
          <AlertDescription>{successMessage}</AlertDescription>
        </Alert>
      )}

      {(errorMessage || error) && (
        <Alert variant="destructive">
          <AlertDescription>{error || errorMessage}</AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle>API Keys</CardTitle>
          <CardDescription>
            Bring your own keys and pay providers directly. A fal.ai key alone
            covers everything — script analysis included.
          </CardDescription>
        </CardHeader>

        <CardContent className="flex flex-col gap-3">
          {/* fal.ai */}
          <div className="flex flex-col gap-3 rounded-xl border p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <FalLogo className="size-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium">fal.ai</h3>
                    {isLoading ? (
                      <Skeleton className="h-5 w-20" />
                    ) : (
                      <StatusBadge source={keyStatus?.fal} />
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    Images, video & audio. Covers script analysis too.
                  </p>
                </div>
              </div>
              {!isLoading && falKey && (
                <div className="flex shrink-0 items-center gap-2">
                  <span className="font-mono text-xs text-muted-foreground">
                    ••••{falKey.keyHint}
                  </span>
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => deleteMutation.mutate('fal')}
                    disabled={deleteMutation.isPending}
                    aria-label="Delete Fal.ai key"
                  >
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              )}
            </div>

            {isLoading ? (
              <Skeleton className="h-10 w-full" />
            ) : (
              !falKey && (
                <div className="flex flex-col gap-2">
                  <form onSubmit={handleSaveFalKey} className="flex gap-2">
                    <Input
                      name="falKey"
                      type="password"
                      placeholder="fal_..."
                      value={falKeyInput}
                      onChange={(e) => setFalKeyInput(e.target.value)}
                      autoComplete="off"
                      spellCheck={false}
                      required
                    />
                    <Button
                      type="submit"
                      disabled={
                        saveFalKeyMutation.isPending || !falKeyInput.trim()
                      }
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
                </div>
              )
            )}
          </div>

          {/* OpenRouter */}
          <div
            className={`flex flex-col gap-3 rounded-xl border p-4 ${
              openrouterKey?.isInvalid ? 'border-destructive' : ''
            }`}
          >
            <div className="flex items-center justify-between gap-3">
              <div className="flex min-w-0 items-center gap-3">
                <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <OpenRouterLogo className="size-5" />
                </div>
                <div className="min-w-0">
                  <div className="flex items-center gap-2">
                    <h3 className="text-sm font-medium">OpenRouter</h3>
                    {isLoading ? (
                      <Skeleton className="h-5 w-20" />
                    ) : openrouterKey?.isInvalid ? (
                      <Badge variant="destructive" className="text-xs">
                        Invalid
                      </Badge>
                    ) : (
                      <StatusBadge source={keyStatus?.openrouter} />
                    )}
                  </div>
                  <p className="truncate text-xs text-muted-foreground">
                    Optional — script analysis falls back to your fal.ai key.
                  </p>
                </div>
              </div>
              {!isLoading &&
                (openrouterKey ? (
                  <div className="flex shrink-0 items-center gap-2">
                    <span className="font-mono text-xs text-muted-foreground">
                      ••••{openrouterKey.keyHint}
                    </span>
                    {openrouterKey.isInvalid && (
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => revalidateMutation.mutate('openrouter')}
                        disabled={revalidateMutation.isPending}
                        aria-label="Re-validate OpenRouter key"
                      >
                        <RotateCcw
                          className={`h-4 w-4 ${revalidateMutation.isPending ? 'animate-spin' : ''}`}
                        />
                      </Button>
                    )}
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => deleteMutation.mutate('openrouter')}
                      disabled={deleteMutation.isPending}
                      aria-label="Delete OpenRouter key"
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </div>
                ) : (
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => oauthMutation.mutate()}
                    disabled={oauthMutation.isPending}
                    aria-label="Connect with OpenRouter"
                  >
                    <ExternalLink className="mr-2 size-3.5" />
                    {oauthMutation.isPending ? 'Connecting…' : 'Connect'}
                  </Button>
                ))}
            </div>

            {openrouterKey?.isInvalid && (
              <Alert variant="destructive">
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  {openrouterKey.invalidReason ||
                    'OpenRouter rejected this key.'}{' '}
                  Re-validate, or reconnect via OAuth to replace it.
                  <div className="mt-2 flex gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => revalidateMutation.mutate('openrouter')}
                      disabled={revalidateMutation.isPending}
                    >
                      {revalidateMutation.isPending
                        ? 'Checking…'
                        : 'Re-validate'}
                    </Button>
                    <Button
                      size="sm"
                      onClick={() => oauthMutation.mutate()}
                      disabled={oauthMutation.isPending}
                    >
                      <ExternalLink className="mr-2 h-4 w-4" />
                      Reconnect
                    </Button>
                  </div>
                </AlertDescription>
              </Alert>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StatusBadge({ source }: { source?: 'team' | 'platform' }) {
  if (source === 'team') {
    return (
      <Badge variant="default" className="text-xs">
        Your key
      </Badge>
    );
  }
  return (
    <Badge variant="secondary" className="text-xs">
      Platform key
    </Badge>
  );
}
