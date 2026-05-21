import { describe, expect, it } from 'bun:test';
import { detectMentionTrigger, insertMention } from './mention-trigger';

describe('detectMentionTrigger', () => {
  it('detects @ at start of text', () => {
    expect(detectMentionTrigger('@ja', 3)).toEqual({ atIndex: 0, query: 'ja' });
  });

  it('detects @ after whitespace', () => {
    const text = 'hello @ja';
    expect(detectMentionTrigger(text, text.length)).toEqual({
      atIndex: 6,
      query: 'ja',
    });
  });

  it('detects @ on empty query (just typed @)', () => {
    const text = 'hello @';
    expect(detectMentionTrigger(text, text.length)).toEqual({
      atIndex: 6,
      query: '',
    });
  });

  it('ignores @ embedded inside a word (email-like)', () => {
    const text = 'user@host';
    expect(detectMentionTrigger(text, text.length)).toBeNull();
  });

  it('returns null when no @ is to the left of caret', () => {
    expect(detectMentionTrigger('hello world', 11)).toBeNull();
  });

  it('closes the window on whitespace after @', () => {
    const text = 'hello @jack denim';
    expect(detectMentionTrigger(text, text.length)).toBeNull();
  });

  it('allows hyphens and underscores in the query', () => {
    const text = '@jack-denim_01';
    expect(detectMentionTrigger(text, text.length)).toEqual({
      atIndex: 0,
      query: 'jack-denim_01',
    });
  });

  it('allows colon (e.g. char_001: prefix)', () => {
    const text = '@char_001:jack';
    expect(detectMentionTrigger(text, text.length)).toEqual({
      atIndex: 0,
      query: 'char_001:jack',
    });
  });
});

describe('insertMention', () => {
  it('replaces @query with canonical tag + trailing space', () => {
    const text = 'A wide shot of @ja';
    const trigger = { atIndex: 15, query: 'ja' };
    const result = insertMention(
      text,
      trigger,
      text.length,
      'jack-denim-jacket'
    );
    expect(result.text).toBe('A wide shot of jack-denim-jacket ');
    expect(result.caret).toBe(result.text.length);
  });

  it('keeps text after the caret intact and avoids a double space', () => {
    const text = 'see @ja later';
    // caret is at index 7 (between "ja" and " later")
    const trigger = { atIndex: 4, query: 'ja' };
    const result = insertMention(text, trigger, 7, 'jack-denim-jacket');
    expect(result.text).toBe('see jack-denim-jacket later');
    expect(result.caret).toBe('see jack-denim-jacket '.length);
  });

  it('handles an empty query (insertion at @)', () => {
    const text = 'tag: @';
    const trigger = { atIndex: 5, query: '' };
    const result = insertMention(text, trigger, text.length, 'RED-HEX-LOGO');
    expect(result.text).toBe('tag: RED-HEX-LOGO ');
    expect(result.caret).toBe(result.text.length);
  });
});
