/**
 * Image Cropping via Cloudflare Image Resizing
 *
 * Instead of downloading grid images and cropping with WASM in-process,
 * returns a `/cdn-cgi/image/trim=T;R;B;L/` URL. Cloudflare crops at the
 * edge when the downstream service (e.g. FAL nano_banana_2) fetches it.
 *
 * Requires Image Resizing enabled on the Cloudflare zone.
 */

type CropTileOptions = {
  gridImageUrl: string;
  row: number; // 1-based (1 = top row)
  col: number; // 1-based (1 = left column)
  gridCols?: number; // total columns in grid (default 3)
  gridRows?: number; // total rows in grid (default 3)
};

type CropTileResult = {
  url: string;
};

/**
 * Read the pixel dimensions from a PNG header (bytes 16-23 of IHDR chunk).
 * Only fetches the first 30 bytes via Range request — no full download.
 */
async function getImageDimensions(
  imageUrl: string
): Promise<{ width: number; height: number }> {
  const response = await fetch(imageUrl, {
    headers: { Range: 'bytes=0-29' },
  });

  const buffer = await response.arrayBuffer();
  const view = new DataView(buffer);

  // PNG: bytes 16-19 = width, 20-23 = height (big-endian uint32)
  // PNG magic: 0x89504E47
  if (view.getUint8(0) === 0x89 && view.getUint8(1) === 0x50) {
    return {
      width: view.getUint32(16, false),
      height: view.getUint32(20, false),
    };
  }

  // JPEG: need to scan for SOF marker — more complex, fall back to full HEAD
  // For now, throw and let the caller handle it
  throw new Error(
    'Could not read image dimensions — only PNG headers are supported'
  );
}

/**
 * Crop a tile from a grid image using Cloudflare Image Resizing.
 * Returns a cdn-cgi/image/trim= URL instead of downloading and processing in-memory.
 *
 * Reads actual image dimensions from the PNG header (30 bytes) to calculate
 * accurate trim values, rather than assuming fixed tile sizes.
 *
 * KNOWN LIMITATION: with locally-served storage (no R2_PUBLIC_STORAGE_DOMAIN)
 * there is no Cloudflare edge, so the returned trim URL won't resolve when a
 * real downstream service fetches it. E2E replay is unaffected (aimock only
 * string-matches); local dev / record runs of the variant-upscale flow would
 * need an Images-binding-based local crop if this becomes a problem.
 */
export async function cropTileFromGrid(
  options: CropTileOptions
): Promise<CropTileResult> {
  const { gridImageUrl, row, col, gridCols = 3, gridRows = 3 } = options;

  if (row < 1 || row > gridRows || col < 1 || col > gridCols) {
    throw new Error(
      `Invalid tile position: row ${row}, col ${col}. Must be 1-${gridRows} and 1-${gridCols}.`
    );
  }

  const { width: gridWidth, height: gridHeight } =
    await getImageDimensions(gridImageUrl);

  const tileWidth = Math.floor(gridWidth / gridCols);
  const tileHeight = Math.floor(gridHeight / gridRows);

  // Calculate trim values (pixels to remove from each edge)
  const trimTop = tileHeight * (row - 1);
  const trimRight = tileWidth * (gridCols - col);
  const trimBottom = tileHeight * (gridRows - row);
  const trimLeft = tileWidth * (col - 1);

  const parsed = new URL(gridImageUrl);
  const trimUrl = `${parsed.origin}/cdn-cgi/image/trim=${trimTop};${trimRight};${trimBottom};${trimLeft}${parsed.pathname}`;

  return { url: trimUrl };
}
