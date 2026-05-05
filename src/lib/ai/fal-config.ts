import { fal } from '@fal-ai/client';

const FAL_HOSTS = new Set([
  'fal.run',
  'queue.fal.run',
  'rest.fal.ai',
  'rest.alpha.fal.ai',
  'gateway.fal.ai',
]);

type FalRequest = Parameters<
  NonNullable<Parameters<typeof fal.config>[0]['requestMiddleware']>
>[0];

let configured = false;

/**
 * Routes server-side fal.ai traffic through a proxy when FAL_PROXY_URL is set.
 *
 * fal-client's built-in `proxyUrl` only activates in the browser — see
 * @fal-ai/client/src/middleware.ts (`withProxy` no-ops when `window` is
 * undefined). Workflows run server-side, so we install a `requestMiddleware`
 * that rewrites fal hosts to the proxy origin while preserving the original
 * pathname. The proxy receives the original host via `x-fal-target-host`.
 *
 * fal-client's `createConfig` does `Object.assign({}, DEFAULT_CONFIG, config)`
 * — so any later `fal.config({...})` caller that omits `requestMiddleware`
 * silently wipes ours. The @tanstack/ai-fal adapters do exactly this on
 * construction. We monkey-patch `fal.config` so our middleware is always
 * composed in, regardless of what callers pass.
 */
export function configureFalProxyFromEnv(): void {
  if (configured) return;
  const proxyUrl = process.env.FAL_PROXY_URL;
  if (!proxyUrl) return;

  const proxy = new URL(proxyUrl);

  const proxyMiddleware = async (request: FalRequest): Promise<FalRequest> => {
    const original = new URL(request.url);
    if (!FAL_HOSTS.has(original.hostname)) return request;

    const rewritten = new URL(proxy.toString());
    rewritten.pathname = proxy.pathname.replace(/\/$/, '') + original.pathname;
    rewritten.search = original.search;

    console.log(
      `[fal-proxy] ${request.method} ${original.hostname}${original.pathname} → ${rewritten.toString()}`
    );

    return {
      ...request,
      url: rewritten.toString(),
      headers: {
        ...request.headers,
        'x-fal-target-host': original.hostname,
      },
    };
  };

  const originalConfig = fal.config.bind(fal);

  const installWithProxy: typeof fal.config = (config) => {
    console.log(
      'installWithProxy - KEY',
      String(process.env.FAL_KEY).slice(0, 5)
    );
    const callerMiddleware = config.requestMiddleware;
    return originalConfig({
      ...config,
      requestMiddleware: callerMiddleware
        ? async (req) => proxyMiddleware(await callerMiddleware(req))
        : proxyMiddleware,
    });
  };

  fal.config = installWithProxy;
  installWithProxy({});

  configured = true;
}
