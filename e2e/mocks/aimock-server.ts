/**
 * aimock Server for E2E Tests
 *
 * Provides a standalone OpenAI-compatible mock server that intercepts
 * server-side LLM calls (OpenRouter) during E2E tests.
 *
 * Browser-side mocks (fal.ai, R2, QStash) remain in handlers.ts via Playwright routes.
 */

import { LLMock, loadFixtureFile, type Fixture } from '@copilotkit/aimock';
import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { createFalHandler } from './fal-handler';

const AIMOCK_PORT = 4010;
const FIXTURE_DIR = resolve(
  import.meta.dirname,
  '../fixtures/recorded/openrouter'
);
// New recordings land here; `record-e2e-fixtures.ts` sorts them into stage
// subfolders by `userMessage` after the run. aimock's loader doesn't recurse,
// so we walk the tree ourselves and skip this staging dir until it's sorted.
const RECORD_STAGING_DIR = resolve(FIXTURE_DIR, '_unsorted');

// OpenRouter SDK validates `system_fingerprint` as `z.nullable(z.string())`,
// rejecting `undefined`. aimock omits the field unless the fixture supplies
// `systemFingerprint`, so stamp a value on every text/tool-call response.
const AIMOCK_SYSTEM_FINGERPRINT = 'fp_aimock';

function stampOne(fixture: Fixture): void {
  const response = fixture.response;
  // Only completion responses (TextResponse / ToolCallResponse /
  // ContentWithToolCallsResponse) extend ResponseOverrides where
  // systemFingerprint lives. Narrow via `in` so other variants
  // (ImageResponse, ErrorResponse, …) are skipped.
  if (!('content' in response) && !('toolCalls' in response)) return;
  if (response.systemFingerprint === undefined) {
    response.systemFingerprint = AIMOCK_SYSTEM_FINGERPRINT;
  }
}

function stampSystemFingerprint(fixtures: Fixture[]): Fixture[] {
  for (const fixture of fixtures) stampOne(fixture);
  return fixtures;
}

// The recorder pushes newly-recorded fixtures straight onto LLMock's internal
// array. Wrap `push`/`unshift` so subsequent replays (e.g. workflow retries)
// also see the stamped `systemFingerprint`.
function patchFixturesArray(fixtures: Fixture[]): void {
  const originalPush = fixtures.push.bind(fixtures);
  fixtures.push = (...items: Fixture[]) => {
    for (const item of items) stampOne(item);
    return originalPush(...items);
  };
  const originalUnshift = fixtures.unshift.bind(fixtures);
  fixtures.unshift = (...items: Fixture[]) => {
    for (const item of items) stampOne(item);
    return originalUnshift(...items);
  };
}

// aimock's `loadFixturesFromDir` is non-recursive (logs and skips subdirs).
// Walk ourselves so stage-folders (`script-enhance/`, `visual-prompts/`, …)
// load.
function loadFixturesRecursive(dirPath: string): Fixture[] {
  const fixtures: Fixture[] = [];
  for (const entry of readdirSync(dirPath, { withFileTypes: true })) {
    const fullPath = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      fixtures.push(...loadFixturesRecursive(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.json')) {
      fixtures.push(...loadFixtureFile(fullPath));
    }
  }
  return fixtures;
}

// Workflow prompts embed runtime ULIDs (talent/location/sequence IDs) that
// drift across fresh DB seeds — recorded `01KQRR…` won't substring-match a
// fresh CI run's `01KQW2…`. Rewrite each fixture's `userMessage` into a
// RegExp where ULIDs/UUIDs become wildcards so matching is ID-tolerant.
// Mirrors `fal-handler.ts:normalizeForHash`, which solves the same problem
// for fal request hashing.
const ULID_TOKEN_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const UUID_TOKEN_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const ULID_OR_UUID_SPLIT_RE = new RegExp(
  `(${ULID_TOKEN_RE.source}|${UUID_TOKEN_RE.source})`,
  'i'
);

function escapeRegex(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function tolerantUserMessageRegex(userMessage: string): RegExp {
  const segments = userMessage.split(ULID_OR_UUID_SPLIT_RE);
  const pattern = segments
    .map((segment, idx) => {
      // Split keeps capture groups, so odd indices are matched tokens.
      if (idx % 2 === 0) return escapeRegex(segment);
      return segment.includes('-')
        ? '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'
        : '[0-9A-HJKMNP-TV-Z]{26}';
    })
    .join('');
  return new RegExp(pattern);
}

function tolerateRuntimeIds(fixtures: Fixture[]): Fixture[] {
  for (const fixture of fixtures) {
    const message = fixture.match.userMessage;
    if (typeof message === 'string') {
      fixture.match.userMessage = tolerantUserMessageRegex(message);
    }
  }
  return fixtures;
}

let mockServer: LLMock | null = null;

export async function startAimockServer(): Promise<string> {
  mockServer = new LLMock({
    port: AIMOCK_PORT,
    strict: true,
    logLevel: 'info',
    // Record locally (real key from .env.local), replay-only on CI (dummy key).
    // Recordings land in `_unsorted/`; the record script sorts them into
    // stage subfolders post-run so they don't pollute the curated layout.
    ...(!process.env.CI && {
      record: {
        providers: { openai: 'https://openrouter.ai/api/v1' },
        fixturePath: RECORD_STAGING_DIR,
      },
    }),
  });

  // Load any previously recorded fixtures
  if (existsSync(FIXTURE_DIR)) {
    mockServer.addFixtures(
      tolerateRuntimeIds(
        stampSystemFingerprint(loadFixturesRecursive(FIXTURE_DIR))
      )
    );
  }

  // Stamp fixtures the recorder appends mid-run too. getFixtures() returns
  // the internal array typed as `readonly` for callers; we monkey-patch its
  // push/unshift, which is exactly what the readonly modifier exists to
  // prevent — hence the cast.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- intentional readonly→mutable widening to install push/unshift hooks
  patchFixturesArray(mockServer.getFixtures() as Fixture[]);

  // Mount fal.ai handler at /fal so workflows can hit fal endpoints via
  // FAL_PROXY_URL=http://localhost:4010/fal. The handler manages its own
  // record/replay (aimock's record providers don't speak fal).
  mockServer.mount('/fal', createFalHandler());

  const url = await mockServer.start();
  console.log(`[e2e] aimock server started at ${url}`);
  return url;
}

export async function stopAimockServer(): Promise<void> {
  if (!mockServer) return;
  try {
    await mockServer.stop();
    console.log('[e2e] aimock server stopped');
  } catch {
    // Server may not have started successfully — ignore stop errors
  }
  mockServer = null;
}
