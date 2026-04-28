import rehypeAutolinkHeadings from 'rehype-autolink-headings';
import rehypeRaw from 'rehype-raw';
import rehypeSlug from 'rehype-slug';
import rehypeStringify from 'rehype-stringify';
import remarkGfm from 'remark-gfm';
import remarkParse from 'remark-parse';
import remarkRehype from 'remark-rehype';
import { codeToHtml } from 'shiki';
import { unified } from 'unified';
import type { Element, Root, RootContent } from 'hast';

export type MarkdownHeading = {
  id: string;
  text: string;
  level: number;
};

export type RenderedMarkdown = {
  markup: string;
  headings: MarkdownHeading[];
};

function extractText(node: Element): string {
  let text = '';
  for (const child of node.children) {
    if (child.type === 'text') {
      text += child.value;
    } else if (child.type === 'element') {
      text += extractText(child);
    }
  }
  return text;
}

/**
 * Rehype plugin that extracts headings from the AST.
 * Pushes { id, text, level } into the provided array for TOC generation.
 */
function rehypeExtractHeadings(headings: MarkdownHeading[]) {
  return () => (tree: Root) => {
    for (const node of tree.children) {
      if (node.type !== 'element') continue;
      const match = /^h([1-6])$/.exec(node.tagName);
      if (!match) continue;
      const level = Number(match[1]);
      const id = String(node.properties?.id ?? '');
      const text = extractText(node);
      headings.push({ id, text, level });
    }
  };
}

/**
 * Rehype plugin that replaces <code> blocks inside <pre> with
 * shiki-highlighted HTML. Uses dual themes for light/dark support.
 */
function rehypeShiki() {
  return async (tree: Root) => {
    const codeBlocks: Array<{ index: number; code: string; lang: string }> = [];

    for (let i = 0; i < tree.children.length; i++) {
      const node = tree.children[i];
      if (
        node.type === 'element' &&
        node.tagName === 'pre' &&
        node.children.length === 1
      ) {
        const child = node.children[0];
        if (child.type === 'element' && child.tagName === 'code') {
          const className = child.properties.className;
          let lang = 'text';
          if (Array.isArray(className)) {
            for (const cls of className) {
              if (typeof cls === 'string' && cls.startsWith('language-')) {
                lang = cls.slice('language-'.length);
                break;
              }
            }
          }
          const code = extractText(child);
          codeBlocks.push({ index: i, code, lang });
        }
      }
    }

    // Process all code blocks in parallel
    const results = await Promise.all(
      codeBlocks.map(async ({ code, lang }) => {
        const html = await codeToHtml(code, {
          lang,
          themes: {
            light: 'github-light',
            dark: 'github-dark',
          },
        });
        return html;
      })
    );

    // Replace nodes with raw HTML (rehype-stringify will output it)
    for (let i = 0; i < codeBlocks.length; i++) {
      const { index } = codeBlocks[i];
      const rawNode: RootContent = {
        type: 'raw',
        value: results[i],
      } satisfies { type: 'raw'; value: string };
      tree.children[index] = rawNode;
    }
  };
}

export async function renderMarkdown(
  content: string
): Promise<RenderedMarkdown> {
  const headings: MarkdownHeading[] = [];

  const result = await unified()
    .use(remarkParse)
    .use(remarkGfm)
    .use(remarkRehype, { allowDangerousHtml: true })
    .use(rehypeRaw)
    .use(rehypeSlug)
    .use(rehypeAutolinkHeadings, { behavior: 'wrap' })
    .use(rehypeShiki)
    .use(rehypeExtractHeadings(headings))
    .use(rehypeStringify, { allowDangerousHtml: true })
    .process(content);

  return {
    markup: String(result),
    headings,
  };
}
