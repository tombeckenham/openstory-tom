import {
  createFalClient as upstreamCreateFalClient,
  fal,
  type FalClient,
  type RequestMiddleware,
} from '@fal-ai/client';

type FalConfig = NonNullable<Parameters<typeof upstreamCreateFalClient>[0]>;

const FAL_HOSTS = new Set([
  'fal.run',
  'queue.fal.run',
  'rest.fal.ai',
  'rest.alpha.fal.ai',
  'gateway.fal.ai',
]);

let configured = false;
let proxyMiddleware: RequestMiddleware | null = null;

function buildProxyMiddleware(proxyUrl: string): RequestMiddleware {
  const proxy = new URL(proxyUrl);
  return async (request) => {
    const original = new URL(request.url);
    if (!FAL_HOSTS.has(original.hostname)) return request;

    const rewritten = new URL(proxy.toString());
    rewritten.pathname = proxy.pathname.replace(/\/$/, '') + original.pathname;
    rewritten.search = original.search;

    return {
      ...request,
      url: rewritten.toString(),
      headers: {
        ...request.headers,
        'x-fal-target-host': original.hostname,
      },
    };
  };
}

function composeMiddleware(
  proxy: RequestMiddleware,
  caller: RequestMiddleware | undefined
): RequestMiddleware {
  if (!caller) return proxy;
  return async (req) => proxy(await caller(req));
}

/**
 * Routes server-side fal.ai traffic through a proxy when FAL_PROXY_URL is set.
 *
 * fal-client's built-in `proxyUrl` only activates in the browser — see
 * `@fal-ai/client/src/middleware.ts` (`withProxy` no-ops when `window` is
 * undefined). Workflows run server-side, so we install a `requestMiddleware`
 * that rewrites fal hosts to the proxy origin while preserving the original
 * pathname. The proxy receives the original host via `x-fal-target-host`.
 *
 * Two paths reach fal.ai from this app: the `@tanstack/ai-fal` adapters call
 * `fal.config({ credentials })` on the singleton and would otherwise wipe any
 * `requestMiddleware` we set, so we monkey-patch `fal.config` to compose ours
 * back in. The other path is callers that build a per-request client via
 * `createFalClient(...)`; that returns an entirely independent client whose
 * config closure the monkey-patch can't touch, so those callers must use the
 * project-local `createFalClient` wrapper exported from this module.
 */
export function configureFalProxyFromEnv(): void {
  if (configured) return;
  configured = true;
  const proxyUrl = process.env.FAL_PROXY_URL;
  if (!proxyUrl) return;

  const middleware = buildProxyMiddleware(proxyUrl);
  proxyMiddleware = middleware;

  const originalConfig = fal.config.bind(fal);
  fal.config = (config) => {
    return originalConfig({
      ...config,
      requestMiddleware: composeMiddleware(
        middleware,
        config.requestMiddleware
      ),
    });
  };
  fal.config({});
}

/**
 * Project-local wrapper around `@fal-ai/client`'s `createFalClient` that
 * composes the env-configured proxy middleware into per-call clients. Use
 * this instead of importing `createFalClient` directly so loudnorm /
 * compose / any future per-call client respects FAL_PROXY_URL.
 */
export function createFalClient(config: FalConfig = {}): FalClient {
  configureFalProxyFromEnv();
  const middleware = proxyMiddleware;
  if (!middleware) return upstreamCreateFalClient(config);

  return upstreamCreateFalClient({
    ...config,
    requestMiddleware: composeMiddleware(middleware, config.requestMiddleware),
  });
}
