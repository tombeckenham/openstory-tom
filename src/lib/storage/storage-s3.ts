/**
 * Storage S3 — AWS S3 SDK implementation for R2 operations.
 * Used on all platforms by default; on Cloudflare, only loaded lazily for signed URLs.
 */

import { getEnv } from '#env';
import {
  CopyObjectCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl as getS3SignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  buildR2Key,
  getPublicUrl,
  type StorageBucket,
  type StorageFileInfo,
  type UploadResult,
} from './buckets';

export function createR2Client(): S3Client {
  const accountId = getEnv().R2_ACCOUNT_ID;
  const accessKeyId = getEnv().R2_ACCESS_KEY_ID;
  const secretAccessKey = getEnv().R2_SECRET_ACCESS_KEY;

  if (!accountId || !accessKeyId || !secretAccessKey) {
    throw new Error(
      'Missing required R2 environment variables: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY'
    );
  }

  return new S3Client({
    region: 'auto',
    endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId,
      secretAccessKey,
    },
  });
}

export function getR2BucketName(): string {
  const bucketName = getEnv().R2_BUCKET_NAME;
  if (!bucketName) {
    throw new Error('R2_BUCKET_NAME environment variable is not set');
  }
  return bucketName;
}

export async function uploadFile(
  bucket: StorageBucket,
  path: string,
  file: File | Blob | ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>,
  options?: {
    upsert?: boolean;
    contentType?: string;
    cacheControl?: string;
  }
): Promise<UploadResult> {
  const bucketName = getR2BucketName();
  const key = buildR2Key(bucket, path);

  try {
    // Use Bun's native S3 client for ReadableStream — AWS SDK v3 in Bun
    // doesn't reliably handle streaming uploads (see commit afdb5ccf).
    // Note: Bun's S3Options doesn't support cacheControl, so streamed files
    // won't get cache headers. This only affects local dev / Railway.
    // Use the `Bun` global rather than `import('bun')` so Vite's import
    // analyzer doesn't try to resolve "bun" as an npm package.
    if (file instanceof ReadableStream) {
      const env = getEnv();
      const bunS3 = new Bun.S3Client({
        accessKeyId: env.R2_ACCESS_KEY_ID,
        secretAccessKey: env.R2_SECRET_ACCESS_KEY,
        bucket: bucketName,
        endpoint: `https://${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      });

      await bunS3.write(key, new Response(file), {
        type: options?.contentType,
      });

      const publicUrl = getPublicUrl(bucket, path);
      return { path: key, publicUrl, fullPath: key };
    }

    const client = createR2Client();

    let body: Uint8Array;
    if (file instanceof Uint8Array) {
      body = file;
    } else if (file instanceof ArrayBuffer) {
      body = new Uint8Array(file);
    } else {
      body = new Uint8Array(await file.arrayBuffer());
    }

    const command = new PutObjectCommand({
      Bucket: bucketName,
      Key: key,
      Body: body,
      ContentType: options?.contentType,
      CacheControl: options?.cacheControl ?? 'public, max-age=31536000',
    });

    await client.send(command);

    const publicUrl = getPublicUrl(bucket, path);

    return {
      path: key,
      publicUrl,
      fullPath: key,
    };
  } catch (error) {
    throw new Error(
      `Failed to upload file to ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getSignedUrl(
  bucket: StorageBucket,
  path: string,
  expiresIn = 3600
): Promise<string> {
  const client = createR2Client();
  const bucketName = getR2BucketName();
  const key = buildR2Key(bucket, path);

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    const url = await getS3SignedUrl(client, command, { expiresIn });
    return url;
  } catch (error) {
    throw new Error(
      `Failed to create signed URL for ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function getSignedUploadUrl(
  bucket: StorageBucket,
  path: string,
  contentType: string,
  expiresIn = 600
): Promise<{
  uploadUrl: string;
  publicUrl: string;
  path: string;
  contentType: string;
}> {
  if (getEnv().E2E_TEST === 'true') {
    const params = new URLSearchParams({ bucket, path, contentType });
    const uploadUrl = `/api/storage/upload?${params}`;
    const publicUrl = getPublicUrl(bucket, path);
    return {
      uploadUrl,
      publicUrl,
      path: buildR2Key(bucket, path),
      contentType,
    };
  }

  const client = createR2Client();
  const bucketName = getR2BucketName();
  const key = buildR2Key(bucket, path);

  const command = new PutObjectCommand({
    Bucket: bucketName,
    Key: key,
    ContentType: contentType,
    CacheControl: 'public, max-age=31536000',
  });

  const uploadUrl = await getS3SignedUrl(client, command, { expiresIn });
  const publicUrl = getPublicUrl(bucket, path);

  return { uploadUrl, publicUrl, path: key, contentType };
}

export async function getSignedUrlWithDownload(
  bucket: StorageBucket,
  path: string,
  filename: string,
  expiresIn = 3600
): Promise<string> {
  const client = createR2Client();
  const bucketName = getR2BucketName();
  const key = buildR2Key(bucket, path);

  try {
    const command = new GetObjectCommand({
      Bucket: bucketName,
      Key: key,
      ResponseContentDisposition: `attachment; filename="${filename}"`,
    });

    const url = await getS3SignedUrl(client, command, { expiresIn });
    return url;
  } catch (error) {
    throw new Error(
      `Failed to create download URL for ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteFile(
  bucket: StorageBucket,
  path: string
): Promise<void> {
  const client = createR2Client();
  const bucketName = getR2BucketName();
  const key = buildR2Key(bucket, path);

  try {
    const command = new DeleteObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    await client.send(command);
  } catch (error) {
    throw new Error(
      `Failed to delete file from ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function deleteFiles(
  bucket: StorageBucket,
  paths: string[]
): Promise<void> {
  if (paths.length === 0) return;

  const client = createR2Client();
  const bucketName = getR2BucketName();

  try {
    const command = new DeleteObjectsCommand({
      Bucket: bucketName,
      Delete: {
        Objects: paths.map((path) => ({ Key: buildR2Key(bucket, path) })),
      },
    });

    await client.send(command);
  } catch (error) {
    throw new Error(
      `Failed to delete files from ${bucket}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function listFiles(
  bucket: StorageBucket,
  path = '',
  options?: {
    limit?: number;
    offset?: number;
    sortBy?: { column: string; order: 'asc' | 'desc' };
  }
): Promise<StorageFileInfo[]> {
  const client = createR2Client();
  const bucketName = getR2BucketName();
  const prefix = buildR2Key(bucket, path);

  try {
    const command = new ListObjectsV2Command({
      Bucket: bucketName,
      Prefix: prefix,
      MaxKeys: options?.limit,
    });

    const response = await client.send(command);

    return (
      response.Contents?.map((item) => ({
        name: item.Key?.replace(`${prefix}/`, '') ?? '',
        id: item.Key ?? '',
        updated_at: item.LastModified?.toISOString() ?? '',
        created_at: item.LastModified?.toISOString() ?? '',
        last_accessed_at: item.LastModified?.toISOString() ?? '',
        metadata: {
          size: item.Size ?? 0,
          mimetype: '',
          cacheControl: '',
          eTag: item.ETag ?? '',
        },
      })) ?? []
    );
  } catch (error) {
    throw new Error(
      `Failed to list files in ${bucket}/${path}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function moveFile(
  bucket: StorageBucket,
  fromPath: string,
  toPath: string
): Promise<void> {
  await copyFile(bucket, fromPath, toPath);
  await deleteFile(bucket, fromPath);
}

export async function copyFile(
  bucket: StorageBucket,
  fromPath: string,
  toPath: string
): Promise<void> {
  const client = createR2Client();
  const bucketName = getR2BucketName();
  const sourceKey = buildR2Key(bucket, fromPath);
  const destKey = buildR2Key(bucket, toPath);

  try {
    const command = new CopyObjectCommand({
      Bucket: bucketName,
      CopySource: `${bucketName}/${sourceKey}`,
      Key: destKey,
    });

    await client.send(command);
  } catch (error) {
    throw new Error(
      `Failed to copy file from ${fromPath} to ${toPath}: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }
}

export async function fileExists(
  bucket: StorageBucket,
  path: string
): Promise<boolean> {
  const client = createR2Client();
  const bucketName = getR2BucketName();
  const key = buildR2Key(bucket, path);

  try {
    const command = new HeadObjectCommand({
      Bucket: bucketName,
      Key: key,
    });

    await client.send(command);
    return true;
  } catch {
    return false;
  }
}
