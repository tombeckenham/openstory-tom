import { describe, expect, it } from 'bun:test';
import type { SequenceElementMinimal } from '@/lib/db/schema';
import { matchElementsToScene } from './scene-matching';

const elements: SequenceElementMinimal[] = [
  {
    id: '1',
    token: 'LOGO',
    description: 'A red hex logo',
    imageUrl: 'https://example.com/logo.png',
    consistencyTag: 'red-hex-logo',
  },
  {
    id: '2',
    token: 'BOTTLE',
    description: 'Silver water bottle',
    imageUrl: 'https://example.com/bottle.png',
    consistencyTag: 'silver-bottle',
  },
];

describe('matchElementsToScene', () => {
  it('matches by elementTags primary path', () => {
    const result = matchElementsToScene(elements, ['LOGO']);
    expect(result.map((e) => e.token)).toEqual(['LOGO']);
  });

  it('matches case-insensitively via elementTags', () => {
    const result = matchElementsToScene(elements, ['logo']);
    expect(result.map((e) => e.token)).toEqual(['LOGO']);
  });

  it('falls back to script text when elementTags is empty', () => {
    const result = matchElementsToScene(
      elements,
      [],
      'She picks up the BOTTLE from the counter.'
    );
    expect(result.map((e) => e.token)).toEqual(['BOTTLE']);
  });

  it('returns empty list when elements list is empty', () => {
    const result = matchElementsToScene([], ['LOGO']);
    expect(result).toEqual([]);
  });

  it('does not match a token that appears inside another word', () => {
    const result = matchElementsToScene(
      elements,
      [],
      'The LOGOISTICS truck arrives.'
    );
    expect(result).toEqual([]);
  });

  it('matches multiple tokens in a single scene', () => {
    const result = matchElementsToScene(elements, ['LOGO', 'BOTTLE']);
    expect(result.map((e) => e.token).sort()).toEqual(['BOTTLE', 'LOGO']);
  });
});
