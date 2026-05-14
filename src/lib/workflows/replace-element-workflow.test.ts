import { describe, expect, it } from 'bun:test';
import { buildEditPrompt } from './replace-element-workflow';

describe('buildEditPrompt', () => {
  it('includes the previous description in parens when present', () => {
    const prompt = buildEditPrompt({
      token: 'LOGO',
      newDescription: 'A blue square logo',
      previousDescription: 'A red hex logo',
    });
    expect(prompt).toContain('LOGO');
    expect(prompt).toContain('(previously: A red hex logo)');
    expect(prompt).toContain('New element description: A blue square logo');
  });

  it('omits the previous description clause when null', () => {
    const prompt = buildEditPrompt({
      token: 'BOTTLE',
      newDescription: 'Silver water bottle',
      previousDescription: null,
    });
    expect(prompt).toContain('BOTTLE');
    expect(prompt).not.toContain('previously:');
    expect(prompt).toContain('New element description: Silver water bottle');
  });

  it('omits the "New element description" line when description is empty', () => {
    const prompt = buildEditPrompt({
      token: 'WIDGET',
      newDescription: '',
      previousDescription: 'old widget',
    });
    expect(prompt).toContain('WIDGET');
    expect(prompt).toContain('(previously: old widget)');
    expect(prompt).not.toContain('New element description:');
  });
});
