/**
 * Element Prompt Helpers
 *
 * Builds reference-image descriptors for user-uploaded sequence elements
 * (logos, products, screenshots) that are referenced by UPPERCASE token in
 * the script.
 */

import type { SequenceElementMinimal } from '@/lib/db/schema';
import type { ReferenceImageDescription } from './reference-image-prompt';

/**
 * Build a concise descriptor for an element for use in reference-image prompts.
 */
export function buildElementDescription(
  element: SequenceElementMinimal
): string {
  const summary = (element.description ?? '').split(/[.,]/)[0].trim();
  const suffix = summary && summary.length < 120 ? ` - ${summary}` : '';
  return `${element.token}${suffix}`;
}

/**
 * Build role-tagged reference images for elements. Elements must have an
 * imageUrl; description is optional — when vision analysis hasn't finished,
 * the token alone is enough context for the image model since the reference
 * image itself carries the visual identity.
 */
export function buildElementReferenceImages(
  elements: SequenceElementMinimal[]
): ReferenceImageDescription[] {
  return elements
    .filter((el) => el.imageUrl)
    .map((el) => ({
      referenceImageUrl: el.imageUrl,
      description: buildElementDescription(el),
      role: 'element' as const,
    }));
}
