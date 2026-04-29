// Chainable no-op stub used by .storybook/server-stub-plugin.ts.
// Every property access returns the same stub; calling it returns the same
// stub; constructing returns the same stub. Lets named imports of any shape
// (function, builder, class, constant) resolve without crashing at load.
//
// `then` returns a thenable that never resolves, so awaiting the result of
// a stubbed server fn (e.g. inside a TanStack Query queryFn) hangs forever
// instead of resolving to the stub itself. That keeps any pre-populated
// query cache data intact — without this, refetchInterval polls would
// overwrite mock data with the stub and crash downstream code that
// destructures it.

/* eslint-disable @typescript-eslint/no-explicit-any */

const target = function noop() {};

const handler: ProxyHandler<typeof target> = {
  get: (_t, prop) => {
    if (prop === 'then') {
      return (_res: unknown, _rej: unknown) => {
        // Hang. queryFn promise never settles, prev cache stays.
      };
    }
    if (prop === '__esModule') return true;
    if (prop === Symbol.toPrimitive) return () => '';
    return stub;
  },
  apply: () => stub,
  construct: () => target,
};

export const stub: any = new Proxy(target, handler);
export default stub;
