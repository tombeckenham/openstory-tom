/**
 * Controlled vocabulary of style use cases.
 * Used to tag templates with the kinds of projects they fit.
 */

export const STYLE_USE_CASES = [
  'talking-head',
  'product',
  'lifestyle',
  'b-roll',
  'animatic',
  'kids',
  'tutorial',
  'pitch-deck',
  'social-vertical',
] as const;

export type StyleUseCase = (typeof STYLE_USE_CASES)[number];

export function isValidStyleUseCase(value: unknown): value is StyleUseCase {
  return (
    typeof value === 'string' &&
    (STYLE_USE_CASES as readonly string[]).includes(value)
  );
}
