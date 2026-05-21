import { describe, expect, it } from 'bun:test';
import {
  buildMentionItems,
  type MentionCharacterInput,
  type MentionElementInput,
  type MentionLocationInput,
} from './mention-items';
import { detectMentionTrigger, insertMention } from './mention-trigger';
import { extractContinuityFromPrompt } from '@/lib/workflows/extract-continuity-from-prompt';
import type { SequenceElementMinimal } from '@/lib/db/schema';

const character: MentionCharacterInput = {
  id: 'c1',
  characterId: 'char_001',
  name: 'Jack',
  consistencyTag: 'char_001: jack-denim-jacket',
  sheetImageUrl: null,
};

const element: MentionElementInput = {
  id: 'e1',
  token: 'red-hex-logo',
  description: 'A red hex logo',
  imageUrl: '',
  consistencyTag: null,
};

const location: MentionLocationInput = {
  id: 'l1',
  locationId: 'loc_001',
  name: 'INT. OFFICE',
  consistencyTag: 'loc_001: office-modern-steel',
  referenceImageUrl: null,
};

const elementMinimal: SequenceElementMinimal = {
  id: element.id,
  token: element.token,
  description: element.description ?? '',
  imageUrl: element.imageUrl,
  consistencyTag: element.consistencyTag,
};

const baseExisting = {
  characterTags: [] as string[],
  elementTags: [] as string[],
  environmentTag: '',
};

function insertByTag(text: string, tag: string): string {
  const seed = `${text}@`;
  const trigger = detectMentionTrigger(seed, seed.length);
  if (!trigger) throw new Error('expected @ trigger');
  return insertMention(seed, trigger, seed.length, tag).text;
}

describe('mention insert → continuity extraction round-trip', () => {
  const items = buildMentionItems({
    characters: [character],
    elements: [element],
    locations: [location],
  });

  it('inserted character tag is recognised by extractContinuityFromPrompt', () => {
    const item = items.find((i) => i.section === 'cast');
    if (!item) throw new Error('cast item missing');
    const prompt = insertByTag('A wide shot featuring ', item.tag);
    const result = extractContinuityFromPrompt({
      promptText: prompt,
      characters: [character],
      elements: [],
      locations: [],
      existing: baseExisting,
    });
    expect(result.characterTags).toEqual(['jack-denim-jacket']);
  });

  it('inserted element tag is recognised by extractContinuityFromPrompt', () => {
    const item = items.find((i) => i.section === 'elements');
    if (!item) throw new Error('element item missing');
    const prompt = insertByTag('Close-up of ', item.tag);
    const result = extractContinuityFromPrompt({
      promptText: prompt,
      characters: [],
      elements: [elementMinimal],
      locations: [],
      existing: baseExisting,
    });
    expect(result.elementTags).toEqual(['RED-HEX-LOGO']);
  });

  it('inserted location tag is recognised by extractContinuityFromPrompt', () => {
    const item = items.find((i) => i.section === 'locations');
    if (!item) throw new Error('location item missing');
    const prompt = insertByTag('Establishing shot in ', item.tag);
    const result = extractContinuityFromPrompt({
      promptText: prompt,
      characters: [],
      elements: [],
      locations: [location],
      existing: baseExisting,
    });
    expect(result.environmentTag).toBe('office-modern-steel');
  });
});
