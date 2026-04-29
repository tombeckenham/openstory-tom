import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Plugin } from 'vite';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');
const STUB_RUNTIME = path.resolve(__dirname, '../src/lib/mocks/server-stub.ts');

// Module paths whose import graph must NOT enter the Storybook bundle.
// These are server-only files that drag Node-only deps (posthog-node, OTel,
// drizzle, fal, qstash, …) into the iframe and crash with "process is not
// defined" or similar. The createServerFn mock already turns the function
// bodies into no-ops, so all we need is for the import to resolve to
// something with the same export names but no real code.
const SERVER_ONLY_PATTERNS: RegExp[] = [
  /^@\/functions(\/|$)/,
  /^@\/lib\/observability(\/|$)/,
  /^@\/lib\/posthog-server$/,
  /^@\/lib\/auth\/server$/,
];

const TS_ALIAS_PREFIX = '@/';

const matchesServerOnly = (id: string): boolean =>
  SERVER_ONLY_PATTERNS.some((re) => re.test(id));

const aliasToFsPath = (id: string): string | null => {
  if (!id.startsWith(TS_ALIAS_PREFIX)) return null;
  return path.resolve(PROJECT_ROOT, 'src', id.slice(TS_ALIAS_PREFIX.length));
};

const resolveSourceFile = async (basePath: string): Promise<string | null> => {
  const candidates = [
    `${basePath}.ts`,
    `${basePath}.tsx`,
    `${basePath}/index.ts`,
    `${basePath}/index.tsx`,
  ];
  for (const candidate of candidates) {
    try {
      await readFile(candidate, 'utf8');
      return candidate;
    } catch {
      // try next
    }
  }
  return null;
};

// Strips block + line comments before scanning for exports.
// Naive but sufficient — we only care about top-level `export …` lines, and
// false positives produce extra harmless named exports on the stub module.
const stripComments = (src: string): string =>
  src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const collectExportNames = (src: string): Set<string> => {
  const names = new Set<string>();
  const code = stripComments(src);

  // export const/let/var X | export function X | export class X
  const declRe =
    /^export\s+(?:async\s+)?(?:const|let|var|function\*?|class)\s+([A-Za-z_$][\w$]*)/gm;
  for (const m of code.matchAll(declRe)) names.add(m[1]);

  // export { a, b as c } [from '...']
  const groupRe = /^export\s*\{([^}]+)\}/gm;
  for (const m of code.matchAll(groupRe)) {
    for (const part of m[1].split(',')) {
      const name = part
        .split(/\s+as\s+/i)
        .pop()
        ?.trim();
      if (name && /^[A-Za-z_$][\w$]*$/.test(name) && name !== 'default') {
        names.add(name);
      }
    }
  }

  // export default … — not a named binding, handled separately
  return names;
};

export function serverStubPlugin(): Plugin {
  return {
    name: 'storybook-server-stub',
    enforce: 'pre',
    async resolveId(source) {
      if (!matchesServerOnly(source)) return null;
      const fsBase = aliasToFsPath(source);
      if (!fsBase) return null;
      const real = await resolveSourceFile(fsBase);
      if (!real) return null;
      // Encode the real path so `load` can read its exports without
      // re-resolving. Prefix with \0 to mark as virtual (Vite convention).
      return `\0server-stub:${real}`;
    },
    async load(id) {
      if (!id.startsWith('\0server-stub:')) return null;
      const realPath = id.slice('\0server-stub:'.length);
      const src = await readFile(realPath, 'utf8');
      const names = collectExportNames(src);
      const namedLines = [...names]
        .map((n) => `export const ${n} = stub;`)
        .join('\n');
      return [
        `import { stub } from '${STUB_RUNTIME}';`,
        `export default stub;`,
        namedLines,
      ].join('\n');
    },
  };
}
