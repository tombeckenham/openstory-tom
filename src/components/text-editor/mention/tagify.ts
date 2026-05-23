/**
 * Convert plain text with bare canonical tags into markdown with inline
 * mention spans, so Tiptap's Mention extension `parseHTML` rule picks them up
 * on `setContent`. Match rules mirror `extract-continuity-from-prompt.ts` —
 * whole-word, case-insensitive, hyphen-aware — so the editor pills exactly
 * what the server-side parser would link on save.
 *
 * Also matches each item's `aliases` (e.g. legacy uppercase-with-spaces
 * element tokens like `RED HEX LOGO`) so existing prompts in the DB still
 * pill correctly. Each match is wrapped as a mention node whose `data-id` is
 * the new canonical `tag` — saving the prompt soft-migrates the storage form
 * to the new convention.
 *
 * Used at editor mount + on every external value sync.
 */

import type { MentionItem } from '@/components/scenes/prompt-mention/mention-items';

function escapeForRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

type TagifyResult = {
  /** Markdown-with-inline-HTML, safe to hand to `editor.commands.setContent`. */
  content: string;
  /** Whether any tags were wrapped. */
  matched: boolean;
};

export function tagifyMarkdown(
  text: string,
  items: MentionItem[]
): TagifyResult {
  if (!text) return { content: '', matched: false };
  if (items.length === 0) return { content: text, matched: false };

  // Build the form→item lookup. Each item contributes its canonical `tag`
  // plus any `aliases` (legacy forms). Longest-first so e.g.
  // `jack-denim-jacket-v2` wins over a shorter alias `jack-denim-jacket`,
  // and a multi-word legacy form `RED HEX LOGO` wins over a substring.
  const forms: Array<{ form: string; item: MentionItem }> = [];
  for (const item of items) {
    forms.push({ form: item.tag, item });
    if (item.aliases) {
      for (const alias of item.aliases) {
        if (alias && alias !== item.tag) forms.push({ form: alias, item });
      }
    }
  }
  forms.sort((a, b) => b.form.length - a.form.length);

  const byForm = new Map<string, MentionItem>();
  for (const { form, item } of forms) {
    byForm.set(form.toLowerCase(), item);
  }

  const alternation = forms.map((f) => escapeForRegex(f.form)).join('|');
  const pattern = new RegExp(
    `(^|[^A-Za-z0-9_-])(${alternation})(?=[^A-Za-z0-9_-]|$)`,
    'gi'
  );

  let out = '';
  let lastIdx = 0;
  let matched = false;
  for (const m of text.matchAll(pattern)) {
    const prefix = m[1];
    const form = m[2];
    if (prefix === undefined || form === undefined) continue;
    const item = byForm.get(form.toLowerCase());
    if (!item) continue;
    const formStart = m.index + prefix.length;
    const formEnd = formStart + form.length;
    out += text.slice(lastIdx, formStart);
    out +=
      `<span data-type="mention"` +
      ` data-id="${escapeHtml(item.tag)}"` +
      ` data-section="${escapeHtml(item.section)}"` +
      ` data-label="${escapeHtml(item.label)}">` +
      `@${escapeHtml(item.tag)}</span>`;
    lastIdx = formEnd;
    matched = true;
  }
  out += text.slice(lastIdx);

  return { content: out, matched };
}
