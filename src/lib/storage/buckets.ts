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

export function getPublicUrl(bucket: StorageBucket, path: string): string {
  const domain = getEnv().R2_PUBLIC_STORAGE_DOMAIN;
  if (!domain) {
    throw new Error(
      'R2_PUBLIC_STORAGE_DOMAIN environment variable is not set. Configure a custom domain for public R2 access.'
    );
  }
  const key = buildR2Key(bucket, path);
  return `https://${domain}/${key}`;
}

export function getPathFromUrl(url: string, bucket: StorageBucket): string {
  const domain = getEnv().R2_PUBLIC_STORAGE_DOMAIN;
  if (!domain) {
    throw new Error('R2_PUBLIC_STORAGE_DOMAIN environment variable is not set');
  }
  const prefix = `https://${domain}/${bucket}/`;
  if (!url.startsWith(prefix)) {
    throw new Error(`URL does not match expected bucket format: ${url}`);
  }
  return url.slice(prefix.length);
}
