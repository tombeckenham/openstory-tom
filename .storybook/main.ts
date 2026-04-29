import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/react-vite';
import type { PluginOption } from 'vite';
import { serverStubPlugin } from './server-stub-plugin';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const config: StorybookConfig = {
  stories: ['../src/**/*.stories.@(js|jsx|mjs|ts|tsx)'],
  addons: [
    '@chromatic-com/storybook',
    '@storybook/addon-docs',
    '@storybook/addon-onboarding',
    '@storybook/addon-a11y',
    '@storybook/addon-themes',
  ],
  framework: {
    name: '@storybook/react-vite',
    options: {},
  },
  staticDirs: ['../public'],
  viteFinal(config) {
    config.resolve = config.resolve ?? {};

    // Mock TanStack Start server functions so they become no-ops in Storybook.
    // Without this, createServerFn calls try to fetch /_serverFn/ which doesn't exist.
    // Use regex so only exact imports are matched (not subpath like /client).
    const mockPath = path.resolve(
      __dirname,
      '../src/lib/mocks/tanstack-start.ts'
    );
    const existingAliases = Array.isArray(config.resolve.alias)
      ? config.resolve.alias
      : Object.entries(config.resolve.alias ?? {}).map(
          ([find, replacement]) => ({ find, replacement })
        );
    config.resolve.alias = [
      ...existingAliases,
      { find: /^@tanstack\/react-start$/, replacement: mockPath },
      { find: /^@tanstack\/react-start\/server$/, replacement: mockPath },
    ];

    // serverStubPlugin replaces server-only modules (server fns, observability,
    // posthog-server, server auth) with synthetic ESM that re-exports a
    // chainable Proxy. Without it, Vite resolves their full import graph and
    // pulls Node-only deps (posthog-node, OTel, drizzle, fal, qstash) into the
    // iframe, crashing with "process is not defined" or similar. Edit the
    // SERVER_ONLY_PATTERNS list in server-stub-plugin.ts to add a new path.
    config.plugins = [serverStubPlugin(), ...(config.plugins ?? [])];

    // Storybook merges the project's vite.config.ts, which registers
    // tanstackStart(). Its sub-plugins (start, router code-splitter,
    // route-tree generator) assume a TanStack Start app shape — single
    // client entry, real route tree — and crash inside Storybook's build
    // (MSW adds a second entry; there's no router). Storybook needs none
    // of them, so strip the whole family.
    const tanstackPluginPrefixes = [
      'tanstack-start:',
      'tanstack-start-core:',
      'tanstack-router:',
      'tanstack:router-generator',
      'start-client-tree-plugin',
    ];
    const isTanstackStartPlugin = (p: PluginOption): boolean => {
      if (
        typeof p !== 'object' ||
        p === null ||
        Array.isArray(p) ||
        !('name' in p)
      ) {
        return false;
      }
      const name = p.name;
      return (
        typeof name === 'string' &&
        tanstackPluginPrefixes.some((prefix) => name.startsWith(prefix))
      );
    };
    const flattenPlugins = (plugins: PluginOption[]): PluginOption[] =>
      plugins.flatMap((p) => (Array.isArray(p) ? flattenPlugins(p) : [p]));
    config.plugins = flattenPlugins(config.plugins ?? []).filter(
      (p) => !isTanstackStartPlugin(p)
    );

    return config;
  },
};
export default config;
