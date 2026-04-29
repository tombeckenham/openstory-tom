// Chainable no-op stub used by .storybook/server-stub-plugin.ts.
// Every property access returns the same stub; calling it returns the same
// stub; constructing returns the same stub. Lets named imports of any shape
// (function, builder, class, constant) resolve without crashing at load.

/* eslint-disable @typescript-eslint/no-explicit-any */

const target = function noop() {};

const handler: ProxyHandler<typeof target> = {
  get: (_t, prop) => {
    if (prop === 'then') return undefined; // not thenable
    if (prop === '__esModule') return true;
    if (prop === Symbol.toPrimitive) return () => '';
    return stub;
  },
  apply: () => stub,
  construct: () => target,
};

export const stub: any = new Proxy(target, handler);
export default stub;
