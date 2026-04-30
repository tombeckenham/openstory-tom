/**
 * Scene matching utilities
 *
 * Pure functions for matching characters and locations to scenes
 * by their continuity tags. Used by analyze-script and frame-images workflows.
 */

import type {
  CharacterMinimal,
  SequenceElementMinimal,
  SequenceLocationMinimal,
} from '@/lib/db/schema';

type CharacterMatchInput = Pick<
  CharacterMinimal,
  'name' | 'characterId' | 'consistencyTag'
>;

// Tokenizes any cased/spaced/punctuated form into a set of snake_case-style
// word tokens, so `"Subject (Anonymous)"` and `"anonymous_subject_..."`
// share the {subject, anonymous} tokens regardless of order.
function tokenize(s: string): string[] {
  return s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

function isSubset(needle: string[], haystack: Set<string>): boolean {
  if (needle.length === 0) return false;
  return needle.every((t) => haystack.has(t));
}

/**
 * Boolean: does any tag in `characterTags` refer to this character?
 *
 * Token-subset match: the character's `name` tokens must be a subset of
 * the tag's tokens (or vice versa for partial references). This is
 * invariant to case, spaces, punctuation, and word order — so
 * `"Subject (Anonymous)"` matches `"anonymous_subject_tattooed_..."`,
 * and `"jack"` no longer accidentally matches `"jacket_of_doom"`.
 *
 * `name` is the authoritative match key (stable across recast and what
 * the LLM is told to emit). `characterId` and `consistencyTag` are
 * fallbacks for legacy frames whose tags pre-date the prompt fix.
 */
export function matchCharacterToFrameTags(
  character: CharacterMatchInput,
  characterTags: string[]
): boolean {
  if (characterTags.length === 0) return false;

  const nameTokens = tokenize(character.name);
  const idTokens = tokenize(character.characterId);
  const consistencyTokens = character.consistencyTag
    ? tokenize(character.consistencyTag)
    : [];

  return characterTags.some((rawTag) => {
    const tagTokens = tokenize(rawTag);
    if (tagTokens.length === 0) return false;
    const tagSet = new Set(tagTokens);

    // Authoritative: name tokens
    if (isSubset(nameTokens, tagSet)) return true;
    // Reverse (partial name reference): tag is just part of the name
    const nameSet = new Set(nameTokens);
    if (isSubset(tagTokens, nameSet)) return true;

    // Fallback: characterId — tag must contain every characterId token
    if (isSubset(idTokens, tagSet)) return true;

    // Fallback: consistencyTag — both directions
    if (isSubset(consistencyTokens, tagSet)) return true;
    const consistencySet = new Set(consistencyTokens);
    if (isSubset(tagTokens, consistencySet)) return true;

    return false;
  });
}

/**
 * Match characters to a scene by their continuity tags.
 * Pure function that works in-memory without DB queries.
 */
export function matchCharactersToScene<T extends CharacterMatchInput>(
  allCharacters: T[],
  characterTags: string[]
): T[] {
  if (characterTags.length === 0) return [];
  return allCharacters.filter((c) =>
    matchCharacterToFrameTags(c, characterTags)
  );
}

/**
 * Match locations to a scene by environment tag or location name.
 * Pure function that works in-memory without DB queries.
 */
export function matchLocationsToScene(
  allLocations: SequenceLocationMinimal[],
  environmentTag: string,
  sceneLocation: string
): SequenceLocationMinimal[] {
  if (!environmentTag && !sceneLocation) return [];

  const envTagLower = environmentTag.toLowerCase();
  const sceneLocLower = sceneLocation.toLowerCase();

  return allLocations.filter((loc) => {
    const consistencyTag = (loc.consistencyTag ?? '').toLowerCase();
    const locName = loc.name.toLowerCase();
    const locId = loc.locationId.toLowerCase();
    const searchTerms = [
      locName,
      locId,
      ...(consistencyTag ? [consistencyTag] : []),
    ];

    // Check if any location identifier appears in the environment tag or scene location
    return searchTerms.some(
      (term) =>
        envTagLower.includes(term) ||
        sceneLocLower.includes(term) ||
        // Reverse match: location name contains the search terms
        term.includes(envTagLower) ||
        term.includes(sceneLocLower)
    );
  });
}

/**
 * Match user-uploaded elements to a scene by UPPERCASE token.
 *
 * Primary match: `elementTags[]` (emitted by the LLM during scene-split).
 * Fallback match: token appears in the raw scene script text — catches
 * cases where the model forgets to populate `elementTags`.
 */
export function matchElementsToScene(
  allElements: SequenceElementMinimal[],
  elementTags: string[],
  sceneScript?: string
): SequenceElementMinimal[] {
  if (allElements.length === 0) return [];

  const tagsUpper = new Set(elementTags.map((t) => t.toUpperCase()));
  const scriptUpper = (sceneScript ?? '').toUpperCase();

  return allElements.filter((el) => {
    const token = el.token.toUpperCase();
    if (tagsUpper.has(token)) return true;
    // Match whole-token occurrence in script text (avoid substring hits in a longer word)
    const re = new RegExp(`(?:^|[^A-Z0-9_])${token}(?:[^A-Z0-9_]|$)`);
    return re.test(scriptUpper);
  });
}
