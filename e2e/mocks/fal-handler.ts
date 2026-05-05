/**
 * fal.ai mock handler mounted on the aimock server.
 *
 * Implements aimock's `Mountable` interface so a single LLMock instance
 * serves both LLM (OpenRouter) and fal.ai traffic.
 *
 * - Replay: matches recorded JSON fixtures keyed by target host, method, path,
 *   and request body hash. Each fixture stores an ordered `responses` array
 *   and a per-process cursor advances one entry per call (clamped at the
 *   last entry), so polling endpoints walk through IN_QUEUE → IN_PROGRESS →
 *   COMPLETED across successive identical requests.
 * - Record: when FAL_RECORD=true, forwards to real fal.ai using FAL_KEY.
 *   The first hit on a fixture path in this process overwrites the file
 *   (fresh slate); subsequent hits append to `responses`, capturing the
 *   real polling progression in one fixture.
 */

import { createHash } from 'node:crypto';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import type * as http from 'node:http';
import { resolve } from 'node:path';

type ResponseEntry = {
  status: number;
  headers: Record<string, string>;
  body: unknown;
};

type FixtureRecord = {
  request: {
    targetHost: string;
    method: string;
    pathname: string;
    bodyHash: string;
  };
  responses: ResponseEntry[];
};

// Pre-sequence format: a single `response` field. Read-only compat for
// fixtures recorded before the multi-response migration.
type LegacyFixtureRecord = {
  request: FixtureRecord['request'];
  response: ResponseEntry;
};

function loadFixture(filePath: string): FixtureRecord {
  const raw: FixtureRecord | LegacyFixtureRecord = JSON.parse(
    readFileSync(filePath, 'utf8')
  );
  const fixture: FixtureRecord =
    'responses' in raw
      ? raw
      : { request: raw.request, responses: [raw.response] };
  // Collapse consecutive identical-status responses on read too, not just on
  // record. Legacy fixtures captured before write-time dedup may contain
  // dozens of identical IN_PROGRESS polls; dedup'ing here lets the cursor
  // reach the next state on the next call instead of after 60 calls.
  return {
    request: fixture.request,
    responses: dedupConsecutiveStatuses(fixture.responses),
  };
}

function dedupConsecutiveStatuses(entries: ResponseEntry[]): ResponseEntry[] {
  const out: ResponseEntry[] = [];
  for (const entry of entries) {
    const last = out.at(-1);
    if (last && last.status === entry.status && sameStatus(last, entry)) {
      continue;
    }
    out.push(entry);
  }
  return out;
}

// True when both entries have a comparable JSON body with an identical
// `status` string. Any other shape (string body, missing field, mismatched
// type) returns false so the recorder appends rather than collapsing.
function sameStatus(a: ResponseEntry, b: ResponseEntry): boolean {
  const aStatus = readBodyStatus(a.body);
  const bStatus = readBodyStatus(b.body);
  return aStatus !== null && aStatus === bStatus;
}

function readBodyStatus(body: unknown): string | null {
  if (body && typeof body === 'object' && 'status' in body) {
    const status = (body as { status: unknown }).status;
    return typeof status === 'string' ? status : null;
  }
  return null;
}

// Per-process replay cursor: index of the next response to serve for each
// fixture file. Clamped at the last entry so over-polling lands on the
// terminal state (e.g. COMPLETED) instead of erroring.
const replayCursor = new Map<string, number>();

// Per-process set of fixture paths already written during this record
// session. First write to a path overwrites (fresh slate); subsequent writes
// append to the `responses` array — that's how a status URL polled multiple
// times accumulates IN_QUEUE → IN_PROGRESS → COMPLETED in one file.
const recordedThisSession = new Set<string>();

const FIXTURE_DIR = resolve(import.meta.dirname, '../fixtures/recorded/fal');

function ensureFixtureDir(): void {
  if (!existsSync(FIXTURE_DIR)) {
    mkdirSync(FIXTURE_DIR, { recursive: true });
  }
}

// ULIDs and UUIDs that appear in image_urls (R2 paths embed teamId, sequenceId,
// frameId, and a fresh upload-suffix ULID per write) drift every test run, so
// hashing the raw body produces a fresh fixture each time. Normalize them to
// stable placeholders before hashing so the same logical request matches the
// same fixture across runs. Record and replay use this same function, keeping
// them symmetric.
const ULID_RE = /\b[0-9A-HJKMNP-TV-Z]{26}\b/g;
const UUID_RE =
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;

function normalizeForHash(body: string): string {
  return body.replace(ULID_RE, '<ULID>').replace(UUID_RE, '<UUID>');
}

function hashBody(body: string): string {
  return createHash('sha256')
    .update(normalizeForHash(body))
    .digest('hex')
    .slice(0, 16);
}

// Diagnostic: each record-mode call appends one JSONL line with the model,
// computed hash, and the *normalized* body (post ULID/UUID strip). After two
// record passes, diff the entries with the same `model` to see exactly what
// stayed volatile and is keeping fixtures from being reused.
//
// Path: e2e/fixtures/recorded/_debug-bodies.jsonl
const DEBUG_LOG_PATH = resolve(
  import.meta.dirname,
  '../fixtures/recorded/_debug-bodies.jsonl'
);

function appendDebugBodyLog(
  targetHost: string,
  method: string,
  pathname: string,
  bodyHash: string,
  rawBody: string
): void {
  if (process.env.FAL_RECORD !== 'true') return;
  const entry = {
    ts: new Date().toISOString(),
    targetHost,
    method,
    pathname,
    bodyHash,
    normalizedBody: normalizeForHash(rawBody),
  };
  try {
    appendFileSync(DEBUG_LOG_PATH, JSON.stringify(entry) + '\n');
  } catch {
    // diagnostic-only; don't break recording on log failure
  }
}

function safeFilename(parts: string[]): string {
  return parts
    .join('__')
    .replace(/[^a-zA-Z0-9_.-]/g, '-')
    .replace(/-+/g, '-');
}

function fixturePath(record: FixtureRecord['request']): string {
  const name = safeFilename([
    record.targetHost,
    record.method,
    record.pathname,
    record.bodyHash,
  ]);
  return resolve(FIXTURE_DIR, `${name}.json`);
}

async function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () =>
      resolveBody(Buffer.concat(chunks as Uint8Array[]).toString('utf8'))
    );
    req.on('error', reject);
  });
}

async function forwardToFal(
  targetHost: string,
  pathname: string,
  search: string,
  method: string,
  headers: Record<string, string>,
  body: string
): Promise<{ status: number; headers: Record<string, string>; body: string }> {
  const falKey = process.env.FAL_KEY;
  if (!falKey || falKey === 'test-mock-key') {
    throw new Error(
      'FAL_RECORD=true requires a real FAL_KEY (not "test-mock-key")'
    );
  }

  // Use Headers (case-insensitive) so set() replaces any inbound
  // `authorization` from the dev server's fal-client. A plain object spread +
  // capital-A `Authorization` leaves both keys distinct, and undici then
  // joins them with a comma — fal rejects the malformed header with 401.
  const url = `https://${targetHost}${pathname}${search}`;
  const upstreamHeaders = new Headers(headers);
  upstreamHeaders.delete('host');
  upstreamHeaders.delete('x-fal-target-host');
  upstreamHeaders.delete('content-length');
  upstreamHeaders.set('authorization', `Key ${falKey}`);

  const init: RequestInit = {
    method,
    headers: upstreamHeaders,
  };
  if (method !== 'GET' && method !== 'HEAD' && body) {
    init.body = body;
  }

  const response = await fetch(url, init);
  const responseBody = await response.text();
  const responseHeaders: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    responseHeaders[key] = value;
  });

  return {
    status: response.status,
    headers: responseHeaders,
    body: responseBody,
  };
}

export function createFalHandler() {
  ensureFixtureDir();

  return {
    async handleRequest(
      req: http.IncomingMessage,
      res: http.ServerResponse,
      pathname: string
    ): Promise<boolean> {
      // aimock strips the mount prefix before dispatching, so `pathname`
      // here is the original fal path (e.g. "/fal-ai/flux/run").
      const targetHostHeader = req.headers['x-fal-target-host'];
      const targetHost =
        typeof targetHostHeader === 'string' ? targetHostHeader : 'fal.run';
      const method = req.method ?? 'GET';
      const falPath = pathname || '/';
      const url = new URL(req.url ?? '/', 'http://localhost');
      const search = url.search;

      const rawBody = await readBody(req);
      const bodyHash = hashBody(rawBody);

      const requestKey: FixtureRecord['request'] = {
        targetHost,
        method,
        pathname: falPath,
        bodyHash,
      };

      const filePath = fixturePath(requestKey);
      const recording = process.env.FAL_RECORD === 'true';

      if (recording) {
        const headers = Object.fromEntries(
          Object.entries(req.headers).map(([k, v]) => [
            k,
            Array.isArray(v) ? v.join(',') : (v ?? ''),
          ])
        );
        const upstream = await forwardToFal(
          targetHost,
          falPath,
          search,
          method,
          headers,
          rawBody
        );
        if (upstream.status >= 400) {
          const keyLen = process.env.FAL_KEY ? process.env.FAL_KEY.length : 0;
          console.warn(
            `[fal-mock] upstream ${upstream.status} from ${targetHost}${falPath} (FAL_KEY length=${keyLen}): ${upstream.body.slice(0, 500)}`
          );
          // Don't bake error responses into the fixture set — surface the
          // failure to the client so the test fails loudly instead.
          writeResponse(res, upstream.status, upstream.headers, upstream.body);
          return true;
        }
        const newEntry: ResponseEntry = {
          status: upstream.status,
          headers: upstream.headers,
          body: tryParseJson(upstream.body),
        };
        if (recordedThisSession.has(filePath) && existsSync(filePath)) {
          const existing = loadFixture(filePath);
          // Collapse consecutive identical statuses (e.g. dozens of
          // IN_PROGRESS polls) so replay walks state transitions instantly
          // instead of replaying the recording's wall-clock pace. Conservative:
          // only fires when both entries have a comparable `body.status`
          // string; any other shape falls through to a plain append.
          const last = existing.responses.at(-1);
          if (
            last &&
            sameStatus(last, newEntry) &&
            last.status === newEntry.status
          ) {
            // Skip write entirely — the existing tail entry already
            // represents this state.
          } else {
            existing.responses.push(newEntry);
            writeFileSync(filePath, JSON.stringify(existing, null, 2));
          }
        } else {
          const record: FixtureRecord = {
            request: requestKey,
            responses: [newEntry],
          };
          writeFileSync(filePath, JSON.stringify(record, null, 2));
          recordedThisSession.add(filePath);
        }
        appendDebugBodyLog(targetHost, method, falPath, bodyHash, rawBody);
        writeResponse(res, upstream.status, upstream.headers, upstream.body);
        return true;
      }

      if (!existsSync(filePath)) {
        const message = `[fal-mock] No fixture for ${targetHost} ${method} ${falPath} (hash ${bodyHash}). Re-record with FAL_RECORD=true.`;
        console.warn(message);
        res.statusCode = 404;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: message }));
        return true;
      }

      const fixture = loadFixture(filePath);
      const cursor = replayCursor.get(filePath) ?? 0;
      const idx = Math.min(cursor, fixture.responses.length - 1);
      replayCursor.set(filePath, cursor + 1);
      const entry = fixture.responses[idx];
      const body =
        typeof entry.body === 'string'
          ? entry.body
          : JSON.stringify(entry.body);
      writeResponse(res, entry.status, entry.headers, body);
      return true;
    },
  };
}

function writeResponse(
  res: http.ServerResponse,
  status: number,
  headers: Record<string, string>,
  body: string
): void {
  res.statusCode = status;
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === 'content-length') continue;
    if (key.toLowerCase() === 'transfer-encoding') continue;
    res.setHeader(key, value);
  }
  res.end(body);
}

function tryParseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
