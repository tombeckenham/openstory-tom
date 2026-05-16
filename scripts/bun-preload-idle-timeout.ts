/**
 * Disable Bun.serve's 10s default idleTimeout for the vite dev server, which
 * kills long-running streaming server-fn responses (structured-output LLM
 * streams) mid-flight with "request timed out after 10 seconds" and a client
 * "TypeError: network error".
 *
 * Bun's node:http shim caches its Bun.serve reference before vite plugins
 * run, so patching from inside vite.config.ts is too late. Bun's --preload
 * runs this file before any other module loads, which catches every Bun.serve
 * call from anywhere in the process.
 *
 * Wired up via package.json: `bun --bun --preload ./scripts/bun-preload-idle-timeout.ts vite dev`.
 * No effect on prod — the post-build Nitro patch in
 * `scripts/patch-bun-idle-timeout.ts` handles that path.
 */
export {};

type ServeFn = (opts: Record<string, unknown>) => unknown;
type PatchableBun = { serve: ServeFn & { __idleTimeoutPatched?: true } };

declare const Bun: PatchableBun | undefined;

if (typeof Bun !== 'undefined' && typeof Bun.serve === 'function') {
  if (!Bun.serve.__idleTimeoutPatched) {
    const original = Bun.serve;
    const patched: ServeFn & { __idleTimeoutPatched?: true } = (opts) =>
      original({ ...opts, idleTimeout: 0 });
    patched.__idleTimeoutPatched = true;
    Bun.serve = patched;
  }
}
