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

/**
 * Match characters to a scene by their continuity tags.
 * Pure function that works in-memory without DB queries.
 */
export function matchCharactersToScene(
  allCharacters: CharacterMinimal[],
  characterTags: string[]
): CharacterMinimal[] {
  if (characterTags.length === 0) return [];

  return allCharacters.filter((char) => {
    const consistencyTag = (char.consistencyTag ?? '').toLowerCase();
    const charName = char.name.toLowerCase();
    const charId = char.characterId.toLowerCase();

    return characterTags.some((tag) => {
      const tagLower = tag.toLowerCase();
      return (
        (consistencyTag && tagLower.includes(consistencyTag)) ||
        (consistencyTag && consistencyTag.includes(tagLower)) ||
        tagLower.includes(charName) ||
        (charName.includes(tagLower) && tagLower.length >= 3) ||
        tagLower.includes(charId)
      );
    });
  });
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
