/**
 * Wires Tiptap's mention suggestion plugin to a React-rendered, portaled
 * dropdown. The dropdown is mounted at the suggestion's clientRect, flipped
 * above the caret if the bottom would clip the viewport.
 *
 * `getItems` is a thunk because the items list is React state in the host
 * component and we need the latest value at suggestion-fire time, not at
 * editor-init time.
 */

import {
  filterMentionItems,
  SECTION_ORDER,
  type MentionItem,
} from '@/components/scenes/prompt-mention/mention-items';
import { ReactRenderer } from '@tiptap/react';
import type { SuggestionOptions, SuggestionProps } from '@tiptap/suggestion';
import {
  MentionList,
  type MentionListProps,
  type MentionListRef,
} from './mention-list';
import type { PromptMentionAttrs } from './mention-extension';

const MAX_ITEMS = 8;
const POPUP_GAP = 6;

type SuggestionConfig = Omit<
  SuggestionOptions<MentionItem, PromptMentionAttrs>,
  'editor'
>;

export function createMentionSuggestion(
  getItems: () => MentionItem[]
): SuggestionConfig {
  return {
    char: '@',

    items: ({ query }) => {
      const filtered = filterMentionItems(getItems(), query);
      // Re-group so the dropdown shows Elements → Cast → Locations in order,
      // regardless of how `mention-items` happened to interleave them.
      const grouped: MentionItem[] = [];
      for (const section of SECTION_ORDER) {
        for (const item of filtered) {
          if (item.section === section) grouped.push(item);
        }
      }
      return grouped.slice(0, MAX_ITEMS);
    },

    command: ({ editor, range, props }) => {
      editor
        .chain()
        .focus()
        .insertContentAt(range, [
          {
            type: 'mention',
            attrs: {
              id: props.id,
              section: props.section,
              label: props.label,
            },
          },
          { type: 'text', text: ' ' },
        ])
        .run();
    },

    render: () => {
      let component: ReactRenderer<MentionListRef> | null = null;
      let popup: HTMLDivElement | null = null;

      const position = (
        el: HTMLDivElement,
        rect: DOMRect | undefined | null
      ): void => {
        if (!rect) return;
        const popupHeight = el.offsetHeight || 280;
        const popupWidth = el.offsetWidth || 320;
        const viewportH = window.innerHeight;
        const viewportW = window.innerWidth;
        const wouldClipBottom =
          rect.bottom + popupHeight + POPUP_GAP > viewportH;
        const top = wouldClipBottom
          ? Math.max(POPUP_GAP, rect.top - popupHeight - POPUP_GAP)
          : rect.bottom + POPUP_GAP;
        const left = Math.min(
          Math.max(POPUP_GAP, rect.left),
          viewportW - popupWidth - POPUP_GAP
        );
        el.style.top = `${top}px`;
        el.style.left = `${left}px`;
      };

      return {
        onStart: (props: SuggestionProps<MentionItem, PromptMentionAttrs>) => {
          component = new ReactRenderer<MentionListRef, MentionListProps>(
            MentionList,
            {
              props: {
                items: props.items,
                command: (item: MentionItem) => {
                  props.command({
                    id: item.tag,
                    section: item.section,
                    label: item.label,
                  });
                },
              },
              editor: props.editor,
            }
          );

          popup = document.createElement('div');
          popup.style.position = 'fixed';
          popup.style.zIndex = '50';
          popup.style.top = '0';
          popup.style.left = '0';
          popup.appendChild(component.element);
          document.body.appendChild(popup);
          position(popup, props.clientRect?.());
        },

        onUpdate: (props: SuggestionProps<MentionItem, PromptMentionAttrs>) => {
          component?.updateProps({
            items: props.items,
            command: (item: MentionItem) => {
              props.command({
                id: item.tag,
                section: item.section,
                label: item.label,
              });
            },
          });
          if (popup) position(popup, props.clientRect?.());
        },

        onKeyDown: (props) => {
          if (props.event.key === 'Escape') {
            popup?.remove();
            popup = null;
            component?.destroy();
            component = null;
            return true;
          }
          const handler = component?.ref?.onKeyDown;
          if (!handler) return false;
          return handler({ event: props.event });
        },

        onExit: () => {
          popup?.remove();
          popup = null;
          component?.destroy();
          component = null;
        },
      };
    },
  };
}
