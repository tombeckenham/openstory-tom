/**
 * Storage buckets — constants, types, and pure functions for R2 storage.
 * Used by both S3 and Cloudflare implementations and by consumers directly.
 */

import { getEnv } from '#env';

export const STORAGE_BUCKETS = {
  THUMBNAILS: 'thumbnails',
  VIDEOS: 'videos',
  AUDIO: 'audio',
  STYLES: 'styles',
  CHARACTERS: 'characters',
  LOCATIONS: 'locations',
  TALENT: 'talent',
  VFX: 'vfx',
  ELEMENTS: 'elements',
} as const;

export type StorageBucket =
  (typeof STORAGE_BUCKETS)[keyof typeof STORAGE_BUCKETS];

export type UploadResult = {
  path: string;
  publicUrl: string;
  fullPath: string;
};

/**
 * One completed part of a multipart upload. Matches R2's `R2UploadedPart`
 * shape so it can be passed straight to `multipartUpload.complete()`.
 */
export type MultipartPart = {
  partNumber: number;
  etag: string;
};

export type StorageFileInfo = {
  name: string;
  id: string;
  updated_at: string;
  created_at: string;
  last_accessed_at: string;
  metadata: {
    size: number;
    mimetype: string;
    cacheControl: string;
    eTag: string;
  };
};

export function buildR2Key(bucket: StorageBucket, path: string): string {
  return `${bucket}/${path}`;
}

/**
 * Base URL under which storage objects are publicly reachable.
 *
 * - With `R2_PUBLIC_STORAGE_DOMAIN` set (production / opt-in remote dev):
 *   the R2 bucket's public CDN domain.
 * - Without it (local dev + e2e): the worker's own `/r2/<key>` serve route
 *   (see `src/routes/r2.$.ts`), backed by the local Miniflare R2 binding —
 *   no remote R2 or credentials needed.
 */
export function getPublicStorageBase(): string {
  const env = getEnv();
  if (!isLocalStorageServing()) {
    return `https://${env.R2_PUBLIC_STORAGE_DOMAIN}`;
  }
  const appUrl = env.VITE_APP_URL;
  if (!appUrl) {
    throw new Error(
      'Neither R2_PUBLIC_STORAGE_DOMAIN nor VITE_APP_URL is set. Configure a public R2 domain or an app URL for the local /r2 serve route.'
    );
  }
  return `${appUrl.replace(/\/$/, '')}/r2`;
}

/**
 * True when storage URLs are served by the local /r2 route.
 *
 * E2E always serves locally — the env-file merge under cf-plugin can leak a
 * developer's `.env.local` CDN domain into the test worker, and which layer
 * wins between wrangler `vars`, `.env*`, and process.env has bitten us before
 * (see the E2E_RECORD note in wrangler.jsonc). Gating on E2E_TEST keeps the
 * decision deterministic.
 */
export function isLocalStorageServing(): boolean {
  const env = getEnv();
  if (env.E2E_TEST === 'true') return true;
  return !env.R2_PUBLIC_STORAGE_DOMAIN;
}

export function getPublicUrl(bucket: StorageBucket, path: string): string {
  return `${getPublicStorageBase()}/${buildR2Key(bucket, path)}`;
}

export function getPathFromUrl(url: string, bucket: StorageBucket): string {
  const prefix = `${getPublicStorageBase()}/${bucket}/`;
  if (!url.startsWith(prefix)) {
    throw new Error(`URL does not match expected bucket format: ${url}`);
  }
  return url.slice(prefix.length);
}
