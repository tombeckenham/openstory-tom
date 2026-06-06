/**
 * Outbound-URL shim for locally-served storage.
 *
 * When `R2_PUBLIC_STORAGE_DOMAIN` is unset, `getPublicUrl()` returns
 * `${VITE_APP_URL}/r2/<key>` URLs that only resolve on this machine. Anything
 * we hand to a REAL external service must therefore be made publicly
 * fetchable first:
 *
 * - fal model inputs (Kling `image_url`, nano-banana `image_urls`, …) →
 *   upload the bytes to fal storage and substitute the returned fal URL.
 * - OpenRouter vision messages → inline the bytes as a base64 data part.
 *
 * Both paths are no-ops when:
 * - a public CDN domain is configured (production / opt-in remote dev), or
 * - the URL isn't ours, or
 * - we're in e2e REPLAY (aimock string-matches request bodies and never
 *   fetches URLs, so the local URL can pass through untouched). Record mode
 *   (`E2E_RECORD=1`) talks to real providers and takes the shim path.
 */

import { getEnv } from '#env';
// Deliberately the UPSTREAM client, not the fal-config wrapper: the shim only
// runs when talking to REAL fal (local dev / e2e record), and routing the
// storage upload through FAL_PROXY_URL would just record meaningless
// storage-initiate fixtures in aimock. Model calls still go through the
// proxied clients as usual.
import { createFalClient } from '@fal-ai/client';
import { getPublicStorageBase, isLocalStorageServing } from './buckets';

function isLocallyServedUrl(url: string): boolean {
  if (!isLocalStorageServing()) return false;
  // Without VITE_APP_URL there is no local serve base to compare against
  // (unit tests run with neither var set) — nothing to shim.
  if (!getEnv().VITE_APP_URL) return false;
  return url.startsWith(`${getPublicStorageBase()}/`);
}

function isReplayMode(): boolean {
  const env = getEnv();
  return env.E2E_TEST === 'true' && env.E2E_RECORD !== '1';
}

function shouldShim(url: string): boolean {
  return isLocallyServedUrl(url) && !isReplayMode();
}

async function fetchLocalBlob(url: string): Promise<Blob> {
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(
      `Failed to read local storage object ${url}: ${res.status}`
    );
  }
  return res.blob();
}

/**
 * Make a storage URL fetchable by real fal. Local `/r2/` URLs are uploaded to
 * fal storage (short-lived scratch space — these are model inputs, not user
 * content); everything else passes through.
 */
export async function ensureExternallyFetchableUrl(
  url: string
): Promise<string> {
  if (!shouldShim(url)) return url;
  const blob = await fetchLocalBlob(url);
  const fal = createFalClient({ credentials: getEnv().FAL_KEY });
  const filename = new URL(url).pathname.split('/').pop() || 'upload';
  const file = new File([blob], filename, { type: blob.type });
  return fal.storage.upload(file);
}

export async function ensureExternallyFetchableUrls(
  urls: string[]
): Promise<string[]> {
  return Promise.all(urls.map((url) => ensureExternallyFetchableUrl(url)));
}

/**
 * Vision-message image source for a storage URL: local URLs become inline
 * base64 data parts (OpenRouter can't fetch localhost); public URLs stay
 * URL-sourced.
 */
export async function toVisionImageSource(
  url: string
): Promise<
  | { type: 'url'; value: string }
  | { type: 'data'; value: string; mimeType: string }
> {
  if (!shouldShim(url)) return { type: 'url', value: url };
  const blob = await fetchLocalBlob(url);
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return {
    type: 'data',
    value: toBase64(bytes),
    mimeType: blob.type || 'image/png',
  };
}

// Web-safe base64 (no node:buffer — this module sits on an import path that
// Vite also walks for the client bundle, where node:* is externalized and
// throws at runtime). Chunked to stay under the JS argument-count limit.
function toBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}
