/**
 * Mention extension configured for character/element/location pills.
 *
 * Storage roundtrip: the markdown serializer writes the bare slug
 * (`jack-denim-jacket`), with no leading `@`. That keeps the persisted
 * prompt/script identical to what `extract-continuity-from-prompt.ts`
 * recognises today — the `@` is purely a render concern.
 *
 * The mention's `id` attr IS the canonical tag. `section` drives the chip
 * colour. `label` is the display name (Jack, INT. OFFICE) used in the
 * dropdown — never serialised back out (only the slug is).
 */

import { Mention } from '@tiptap/extension-mention';
import type { MarkdownNodeSpec } from 'tiptap-markdown';

export type MentionSection = 'cast' | 'elements' | 'locations';

/**
 * All attrs are nullable because Tiptap defaults them to null at the schema
 * level — a half-typed mention can briefly exist between user keystroke and
 * `command()` firing. Renderers must guard.
 */
export type PromptMentionAttrs = {
  id: string | null;
  section: MentionSection | null;
  label: string | null;
};

function readPromptAttrs(attrs: Record<string, unknown>): PromptMentionAttrs {
  const idRaw = attrs.id;
  const sectionRaw = attrs.section;
  const labelRaw = attrs.label;
  return {
    id: typeof idRaw === 'string' ? idRaw : null,
    section:
      typeof sectionRaw === 'string' && isMentionSection(sectionRaw)
        ? sectionRaw
        : null,
    label: typeof labelRaw === 'string' ? labelRaw : null,
  };
}

const SECTION_CLASS: Record<MentionSection, string> = {
  cast: 'bg-sky-500/10 text-sky-700 ring-sky-500/30 dark:text-sky-300',
  elements:
    'bg-amber-500/10 text-amber-800 ring-amber-500/30 dark:text-amber-300',
  locations:
    'bg-emerald-500/10 text-emerald-800 ring-emerald-500/30 dark:text-emerald-300',
};

const BASE_PILL_CLASS =
  'inline rounded px-1.5 py-0.5 text-[0.95em] font-medium leading-tight align-baseline ring-1 ring-inset whitespace-nowrap';

function isMentionSection(value: string): value is MentionSection {
  return value === 'cast' || value === 'elements' || value === 'locations';
}

export const PromptMention = Mention.extend({
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-id'),
        renderHTML: (attrs: { id?: string | null }) =>
          attrs.id ? { 'data-id': attrs.id } : {},
      },
      section: {
        default: null,
        parseHTML: (el) => {
          const raw = el.getAttribute('data-section');
          return raw && isMentionSection(raw) ? raw : null;
        },
        renderHTML: (attrs: { section?: MentionSection | null }) =>
          attrs.section ? { 'data-section': attrs.section } : {},
      },
      label: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-label'),
        renderHTML: (attrs: { label?: string | null }) =>
          attrs.label ? { 'data-label': attrs.label } : {},
      },
    };
  },

  addStorage() {
    const markdown: MarkdownNodeSpec = {
      serialize(state, node) {
        // Bare slug. The `@` is a render-only flourish, never stored.
        const id = readPromptAttrs(node.attrs).id;
        if (id) state.write(id);
      },
    };
    return {
      ...this.parent?.(),
      markdown,
    };
  },
}).configure({
  HTMLAttributes: {
    class: BASE_PILL_CLASS,
    spellcheck: 'false',
  },
  renderHTML: ({ node, options }) => {
    const attrs = readPromptAttrs(node.attrs);
    const sectionClass = attrs.section ? SECTION_CLASS[attrs.section] : '';
    const baseClass =
      (options.HTMLAttributes as { class?: string }).class ?? '';
    const className = `${baseClass} ${sectionClass}`.trim();
    return [
      'span',
      {
        ...options.HTMLAttributes,
        class: className,
        'data-type': 'mention',
        ...(attrs.id ? { 'data-id': attrs.id } : {}),
        ...(attrs.section ? { 'data-section': attrs.section } : {}),
        ...(attrs.label ? { 'data-label': attrs.label } : {}),
      },
      `@${attrs.id ?? ''}`,
    ];
  },
  renderText: ({ node }) => {
    // ProseMirror falls back to `renderText` when a node is copied to plain
    // text. Emit the bare slug so paste-into-another-app round-trips through
    // the server-side parser without leaking the `@`.
    return readPromptAttrs(node.attrs).id ?? '';
  },
  deleteTriggerWithBackspace: true,
});
