/**
 * Upload a merged MP4 Blob to R2 using a presigned PUT URL (S3 deployments)
 * or the same-origin /api/storage/upload proxy (Cloudflare Workers).
 *
 * The shape of `uploadUrl` is provided by the server function
 * `requestMergedUploadUrlFn`, which delegates to `getSignedUploadUrl`.
 */

export async function uploadMergedBlob(args: {
  blob: Blob;
  uploadUrl: string;
  contentType: string;
  signal?: AbortSignal;
  /**
   * Abort the PUT after this many ms. A hung R2 proxy otherwise leaves the
   * request pending indefinitely (no response, no error), which the UI shows
   * as a stuck progress state. Omit to disable the timeout.
   */
  timeoutMs?: number;
}): Promise<void> {
  const { blob, uploadUrl, contentType, signal, timeoutMs } = args;

  // Combine the caller's signal with a timeout so either can abort the PUT.
  const timeoutController = new AbortController();
  const timer =
    timeoutMs !== undefined
      ? setTimeout(() => timeoutController.abort(), timeoutMs)
      : undefined;
  const fetchSignal = signal
    ? AbortSignal.any([signal, timeoutController.signal])
    : timeoutController.signal;

  try {
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      body: blob,
      headers: { 'Content-Type': contentType },
      signal: fetchSignal,
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(
        `Upload failed: ${response.status} ${response.statusText}${body ? ` — ${body.slice(0, 200)}` : ''}`
      );
    }
  } catch (error) {
    // Distinguish a timeout from a user-initiated abort so the toast is useful.
    if (timeoutController.signal.aborted && !signal?.aborted) {
      throw new Error(
        `Upload timed out after ${Math.round((timeoutMs ?? 0) / 1000)}s — the storage upload did not complete.`
      );
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}
