import type { ImageSize } from '@/lib/constants/aspect-ratios';

type GridLayout = {
  cols: number;
  rows: number;
};

/**
 * Get the arrangement description for the opening sentence based on grid shape
 */
function getArrangementDescription(grid: GridLayout, count: number): string {
  if (grid.rows === 1) {
    return `${grid.cols} side-by-side vertical portrait panels. Each panel should be a complete portrait-oriented composition showing a distinct variant shot`;
  }
  return `${grid.cols} panels across (horizontal) and ${grid.rows} panels down (vertical). It should be a sequence of ${count} distinct frames showing a progression of action, laid out in a ${grid.cols}-column by ${grid.rows}-row grid`;
}

/**
 * Get the aspect ratio instruction based on image size and grid shape
 */
function getAspectRatioDescription(
  imageSize: ImageSize,
  grid: GridLayout,
  count: number
): string {
  if (grid.rows === 1) {
    return `The final image is landscape orientation (16:9 aspect ratio, wider than tall). Arrange the ${count} panels as ${grid.cols} side-by-side vertical portrait columns of equal width, filling the entire image. Each column is a complete portrait-oriented (9:16) composition.`;
  }
  switch (imageSize) {
    case 'square_hd':
      return `The final image is square (1:1 aspect ratio). Arrange the ${count} panels in a balanced ${grid.cols}x${grid.rows} grid.`;
    case 'landscape_16_9':
    default:
      return `The final image is landscape orientation (16:9 aspect ratio, wider than tall). Arrange the ${count} panels in a ${grid.cols}-column by ${grid.rows}-row grid that fits naturally within a wide, horizontal frame.`;
  }
}

/**
 * Generate variant image prompt with aspect ratio context and optional scene description
 */
export function getVariantImagePrompt(
  imageSize: ImageSize,
  scenePrompt?: string,
  grid: GridLayout = { cols: 3, rows: 3 }
): string {
  const count = grid.cols * grid.rows;
  const arrangement = getArrangementDescription(grid, count);
  const aspectDescription = getAspectRatioDescription(imageSize, grid, count);

  const sceneContext = scenePrompt
    ? `\nScene Description:\n${scenePrompt}\n`
    : '';

  return `Create a ${count}-panel cinematic storyboard sheet arranged as exactly ${arrangement}. Derived from the style and subject of Image 1 (the primary source scene). Include 'Wide' (setting the scene), 'Medium' (action), and 'Tight' (emotion) shots. There should be no borders between images.

Visual Parameters:

Character Consistency: Every panel must show the EXACT SAME character(s) as Image 1 — identical face, hair color, hair style, skin tone, body type, and clothing. If character reference sheets are provided, match their likeness precisely in every panel. Do NOT change, substitute, or alter any character's appearance between panels.

Lighting: Match Image 1's lighting setup exactly.

Texture: Match Image 1's texture and grain characteristics.

Color: Color grade must perfectly match Image 1's LUT.

Strict Negative Constraint: No borders between images, Zero text. No dialogue bubbles, no scene numbers, no 'Lorem Ipsum', and no subtitles. The final image should look like a clean, text-free photography contact sheet.

Aspect Ratio: ${aspectDescription}

${sceneContext}

CRITICAL: All ${count} panels must depict variant shots of the SAME scene shown in Image 1 with the SAME character(s). Any additional reference images (characters, locations) are provided solely for likeness and environment consistency — do NOT turn them into separate panels or subjects. The character's appearance must be identical across all ${count} panels.

`;
}
