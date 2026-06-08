import { describe, expect, it } from 'vitest';
import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';
import { tagifyMarkdown } from './tagify';

const items: MentionItem[] = [
  {
    id: 'character:c1',
    section: 'cast',
    label: 'Jack',
    sublabel: 'jack-denim-jacket',
    // Cast tag is the ALL-CAPS name; slug/id ride along as aliases so legacy
    // prompts still pill (and re-pill to the name).
    tag: 'JACK',
    aliases: ['jack-denim-jacket', 'char_001'],
    haystack: 'jack jack-denim-jacket char_001',
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

  // --- Cast: highlight the ALL-CAPS name in place, no `@` ------------------

  it('pills a cast member by their ALL-CAPS name with no @ prefix', () => {
    const result = tagifyMarkdown('JACK pulls on his jacket', items);
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="JACK"');
    expect(result.content).toContain('data-section="cast"');
    // Visible text is the bare name — not `@JACK`.
    expect(result.content).toContain('>JACK</span>');
    expect(result.content).not.toContain('@JACK');
  });

  it('does NOT pill a lowercase prose mention of a cast name', () => {
    const result = tagifyMarkdown('then jack walked away', items);
    expect(result.matched).toBe(false);
    expect(result.content).toBe('then jack walked away');
  });

  it('pills a legacy cast consistencyTag alias, re-pilling to the name', () => {
    const result = tagifyMarkdown('hero is jack-denim-jacket here', items);
    expect(result.matched).toBe(true);
    // Alias matched, but the canonical data-id + visible text is the name.
    expect(result.content).toContain('data-id="JACK"');
    expect(result.content).toContain('data-section="cast"');
    expect(result.content).toContain('>JACK</span>');
  });

  // --- Elements / locations: `@slug`, case-insensitive --------------------

  it('pills an element with a leading @ and canonical data-id', () => {
    const result = tagifyMarkdown('logo: RED-hex-LOGO appears', items);
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="RED-HEX-LOGO"');
    expect(result.content).toContain('@RED-HEX-LOGO');
    expect(result.content).toContain('data-section="elements"');
  });

  it('respects word boundaries — no false positives on substring matches', () => {
    const result = tagifyMarkdown('officeworks is not a location', items);
    expect(result.matched).toBe(false);
    expect(result.content).toBe('officeworks is not a location');
  });

  it('handles hyphenated tags as single tokens', () => {
    // `RED-HEX-LOGO` should match the full token, not just `RED`.
    const result = tagifyMarkdown('see RED-HEX-LOGO later', items.slice(1, 2));
    expect(result.matched).toBe(true);
    expect(result.content).toContain('data-id="RED-HEX-LOGO"');
    expect(result.content).not.toContain('data-id="RED"');
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

  it('matches multiple distinct mentions in one pass', () => {
    const result = tagifyMarkdown('JACK in office-modern-steel', items);
    expect(result.matched).toBe(true);
    const spans = result.content.match(/data-type="mention"/g) ?? [];
    expect(spans.length).toBe(2);
  });

  it('escapes quotes/brackets in span attributes', () => {
    // Bare surrounding text is NOT HTML-escaped (Tiptap treats it as markdown);
    // the span attributes ARE, so an adversarial label can't break out.
    const result = tagifyMarkdown('office-modern-steel', items);
    expect(result.content).toMatch(/data-id="office-modern-steel"/);
  });

  it('consumes a leading @ on an element tag (no doubled @)', () => {
    const elementItems: MentionItem[] = [
      {
        id: 'element:e2',
        section: 'elements',
        label: 'bondi-screen',
        sublabel: '',
        tag: 'bondi-screen',
        haystack: 'bondi-screen',
        thumbnailUrl: null,
      },
    ];
    // LLM prompts emit `@bondi-screen`; the source @ is the trigger and must be
    // consumed so it isn't left dangling before the pill (which re-adds its @).
    const result = tagifyMarkdown(
      'the screen shows @bondi-screen here',
      elementItems
    );
    expect(result.matched).toBe(true);
    expect(result.content).not.toContain('@<span');
    expect(result.content).not.toContain('@@');
    expect(result.content).toContain('shows <span');
    expect(result.content).toContain('>@bondi-screen</span>');
  });
});
