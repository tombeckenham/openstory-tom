/**
 * fal.ai mock handler mounted on the aimock server.
 *
 * Implements aimock's `Mountable` interface so a single LLMock instance
 * serves both LLM (OpenRouter) and fal.ai traffic.
 *
 * - Replay: matches recorded JSON fixtures keyed by target host, method, path,
 *   and request body hash.
 * - Record: when FAL_RECORD=true, forwards to real fal.ai using FAL_KEY,
 *   writes the response to disk, then returns it.
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

type FixtureRecord = {
  request: {
    targetHost: string;
    method: string;
    pathname: string;
    bodyHash: string;
  };
  response: {
    status: number;
    headers: Record<string, string>;
    body: unknown;
  };
};

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
          const keyLen = (process.env.FAL_KEY ?? '').length;
          console.warn(
            `[fal-mock] upstream ${upstream.status} from ${targetHost}${falPath} (FAL_KEY length=${keyLen}): ${upstream.body.slice(0, 500)}`
          );
          // Don't bake error responses into the fixture set — surface the
          // failure to the client so the test fails loudly instead.
          writeResponse(res, upstream.status, upstream.headers, upstream.body);
          return true;
        }
        const record: FixtureRecord = {
          request: requestKey,
          response: {
            status: upstream.status,
            headers: upstream.headers,
            body: tryParseJson(upstream.body),
          },
        };
        writeFileSync(filePath, JSON.stringify(record, null, 2));
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

      const fixture: FixtureRecord = JSON.parse(readFileSync(filePath, 'utf8'));
      const body =
        typeof fixture.response.body === 'string'
          ? fixture.response.body
          : JSON.stringify(fixture.response.body);
      writeResponse(
        res,
        fixture.response.status,
        fixture.response.headers,
        body
      );
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
