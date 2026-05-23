/**
 * Builds the sectioned mention-item list from sequence characters, elements,
 * and locations. The `tag` field is the canonical string inserted into the
 * prompt and recognised by `extract-continuity-from-prompt.ts`.
 */

import type {
  CharacterWithTalent,
  SequenceElement,
  SequenceLocation,
} from '@/lib/db/schema';

export type MentionSection = 'elements' | 'cast' | 'locations';

/** Fields buildMentionItems actually consumes. */
export type MentionCharacterInput = Pick<
  CharacterWithTalent,
  'id' | 'characterId' | 'name' | 'consistencyTag' | 'sheetImageUrl'
>;
export type MentionElementInput = Pick<
  SequenceElement,
  'id' | 'token' | 'description' | 'imageUrl' | 'consistencyTag'
>;
export type MentionLocationInput = Pick<
  SequenceLocation,
  'id' | 'locationId' | 'name' | 'consistencyTag' | 'referenceImageUrl'
>;

export type MentionItem = {
  id: string;
  section: MentionSection;
  /** Display label (e.g. character name or element token). */
  label: string;
  /** Optional secondary line (e.g. character id, location id). */
  sublabel?: string;
  /** Canonical tag inserted into the prompt + emitted by the markdown serializer. */
  tag: string;
  /**
   * Additional patterns that should also pill to this item when found in
   * existing prompt text. Used for legacy formats (e.g. elements stored as
   * `RED HEX LOGO` uppercase-with-spaces) so old prompts still pill — saving
   * the prompt re-serializes everything to the canonical `tag`, soft-migrating
   * the storage format on edit.
   */
  aliases?: string[];
  /** Lowercase haystack for filtering. */
  haystack: string;
  thumbnailUrl?: string | null;
};

/** Strip "char_001: " prefix from a consistencyTag to get the slug half. */
function consistencyTagSlug(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const idx = raw.indexOf(':');
  const slug = (idx >= 0 ? raw.slice(idx + 1) : raw).trim();
  return slug.length > 0 ? slug : null;
}

/**
 * Derive the new canonical kebab tag from a legacy uppercase-with-spaces or
 * UPPERCASE_SNAKE_CASE token. `RED HEX LOGO` → `red-hex-logo`, `PEPSI_LOGO`
 * → `pepsi-logo`. Keeps only `[a-z0-9-]` and trims edge separators.
 */
function elementKebabFromToken(token: string): string {
  return token
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export function buildMentionItems(args: {
  characters: MentionCharacterInput[];
  elements: MentionElementInput[];
  locations: MentionLocationInput[];
}): MentionItem[] {
  const items: MentionItem[] = [];

  for (const el of args.elements) {
    // New convention: lowercase kebab. Prefer the vision-LLM consistencyTag
    // when present (already a clean slug); otherwise derive from the token.
    const consistencySlug = consistencyTagSlug(el.consistencyTag);
    const tag = consistencySlug || elementKebabFromToken(el.token) || el.token;
    // Legacy form (e.g. `RED HEX LOGO`) still appears in existing prompts —
    // alias-match so old text auto-pills to the same item.
    const aliases = el.token && el.token !== tag ? [el.token] : undefined;
    items.push({
      id: `element:${el.id}`,
      section: 'elements',
      label: tag,
      sublabel: el.description ?? undefined,
      tag,
      ...(aliases ? { aliases } : {}),
      haystack: [tag, el.token, el.description ?? '', el.consistencyTag ?? '']
        .join(' ')
        .toLowerCase(),
      thumbnailUrl: el.imageUrl,
    });
  }

  for (const c of args.characters) {
    const slug = consistencyTagSlug(c.consistencyTag);
    // Prefer the human-readable slug; fall back to the stable id.
    const tag = slug ?? c.characterId;
    items.push({
      id: `character:${c.id}`,
      section: 'cast',
      label: c.name,
      sublabel: tag,
      tag,
      haystack: [c.name, tag, c.characterId, slug ?? '']
        .join(' ')
        .toLowerCase(),
      thumbnailUrl: c.sheetImageUrl,
    });
  }

  for (const loc of args.locations) {
    const slug = consistencyTagSlug(loc.consistencyTag);
    const tag = slug ?? loc.locationId;
    items.push({
      id: `location:${loc.id}`,
      section: 'locations',
      label: loc.name,
      sublabel: tag,
      tag,
      haystack: [loc.name, tag, loc.locationId, slug ?? '']
        .join(' ')
        .toLowerCase(),
      thumbnailUrl: loc.referenceImageUrl,
    });
  }

  return items;
}

export function filterMentionItems(
  items: MentionItem[],
  query: string
): MentionItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return items;
  return items.filter((item) => item.haystack.includes(q));
}

export const SECTION_LABELS: Record<MentionSection, string> = {
  elements: 'Elements',
  cast: 'Cast',
  locations: 'Locations',
};

export const SECTION_ORDER: MentionSection[] = [
  'elements',
  'cast',
  'locations',
];
