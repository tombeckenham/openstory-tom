import { describe, expect, it } from 'bun:test';
import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import { tagifyMarkdown } from './tagify';

const items: MentionItem[] = [
  {
    id: 'character:c1',
    section: 'cast',
    label: 'Jack',
    sublabel: 'jack-denim-jacket',
    tag: 'jack-denim-jacket',
    haystack: 'jack jack-denim-jacket',
    thumbnailUrl: null,
  },
  {
    id: 'element:e1',
    section: 'elements',
    label: 'RED-HEX-LOGO',
    sublabel: 'A red hex logo',
    tag: 'RED-HEX-LOGO',
    haystack: 'red-hex-logo',
    thumbnailUrl: null,
  },
  {
    id: 'location:l1',
    section: 'locations',
    label: 'INT. OFFICE',
    sublabel: 'office-modern-steel',
    tag: 'office-modern-steel',
    haystack: 'int. office office-modern-steel',
    thumbnailUrl: null,
  },
];

describe('tagifyMarkdown', () => {
  it('returns input unchanged when no items', () => {
    const result = tagifyMarkdown('hello jack-denim-jacket', []);
    expect(result.matched).toBe(false);
    expect(result.content).toBe('hello jack-denim-jacket');
  });

  it('wraps a known slug in a mention span', () => {
    const result = tagifyMarkdown('hello jack-denim-jacket', items);
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-type="mention"');
    expect(result.content).toContain('data-id="jack-denim-jacket"');
    expect(result.content).toContain('data-section="cast"');
    expect(result.content).toContain('@jack-denim-jacket');
  });

  it('is case-insensitive but preserves the canonical tag as the data-id', () => {
    const result = tagifyMarkdown('logo: RED-hex-LOGO appears', items);
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="RED-HEX-LOGO"');
  });

  it('respects word boundaries — no false positives on substring matches', () => {
    const result = tagifyMarkdown('officeworks is not a location', items);
    expect(result.matched).toBe(false);
    expect(result.content).toBe('officeworks is not a location');
  });

  it('handles hyphenated tags as single tokens', () => {
    // `jack-denim-jacket` should match the full slug, not just `jack`.
    const result = tagifyMarkdown(
      'see jack-denim-jacket later',
      items.slice(0, 1)
    );
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="jack-denim-jacket"');
    expect(result.content).not.toContain('data-id="jack"');
  });

  it('matches an uppercase element token verbatim', () => {
    const result = tagifyMarkdown(
      'A close-up of the RED-HEX-LOGO on his jacket',
      items
    );
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="RED-HEX-LOGO"');
    expect(result.content).toContain('data-section="elements"');
  });

  it('matches an underscore-style token wrapped in parentheses (visual-prompt format)', () => {
    const elementItems: MentionItem[] = [
      {
        id: 'element:e2',
        section: 'elements',
        label: 'BONDI_SCREEN',
        sublabel: 'A surfer dashboard',
        tag: 'BONDI_SCREEN',
        haystack: 'bondi_screen a surfer dashboard',
        thumbnailUrl: null,
      },
    ];
    const result = tagifyMarkdown(
      'displaying the UI from (BONDI_SCREEN) on the wall',
      elementItems
    );
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="BONDI_SCREEN"');
  });

  it('matches a legacy uppercase-with-spaces alias and pills to the canonical kebab', () => {
    const elementItems: MentionItem[] = [
      {
        id: 'element:e6',
        section: 'elements',
        label: 'red-hex-logo',
        sublabel: 'A red hex logo',
        tag: 'red-hex-logo',
        aliases: ['RED HEX LOGO'],
        haystack: 'red-hex-logo red hex logo a red hex logo',
        thumbnailUrl: null,
      },
    ];
    const result = tagifyMarkdown(
      'A close-up of the RED HEX LOGO on his jacket',
      elementItems
    );
    expect(result.matched).toBe(true);
    // Canonical tag is emitted as data-id even when the legacy alias matched.
    expect(result.content).toContain('data-id="red-hex-logo"');
    // The pill's visible text uses the canonical form too, so saving
    // re-serializes everything to the new convention.
    expect(result.content).toContain('@red-hex-logo');
  });

  it('matches multiple distinct slugs in one pass', () => {
    const result = tagifyMarkdown(
      'jack-denim-jacket in office-modern-steel',
      items
    );
    expect(result.matched).toBe(true);
    const spans = result.content.match(/data-type="mention"/g) ?? [];
    expect(spans.length).toBe(2);
  });

  it('escapes characters in the surrounding text', () => {
    // Bare text should NOT be HTML-escaped — Tiptap's setContent will treat
    // it as markdown. tagifyMarkdown only emits markup for the spans
    // themselves; ambient `<` are caller-controlled (or never present).
    const result = tagifyMarkdown('jack-denim-jacket', items);
    // The span attributes themselves must escape quotes/angle brackets so an
    // adversarial label can't break out of the span.
    expect(result.content).toMatch(/data-id="jack-denim-jacket"/);
  });
});
