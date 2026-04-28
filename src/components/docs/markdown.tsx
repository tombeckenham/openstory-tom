import { Link } from '@tanstack/react-router';
import type { DOMNode } from 'html-dom-parser';
import parse, {
  type HTMLReactParserOptions,
  attributesToProps,
  domToReact,
} from 'html-react-parser';
import { MermaidDiagram } from './mermaid-diagram';

type MarkdownContentProps = {
  markup: string;
  className?: string;
};

function isInternalLink(href: string): boolean {
  return href.startsWith('/');
}

function childrenToDOMNodes(children: readonly unknown[]): DOMNode[] {
  return children.filter(
    (child): child is DOMNode =>
      typeof child === 'object' &&
      child !== null &&
      'type' in child &&
      typeof (child as { type: unknown }).type === 'string'
  );
}

const parserOptions: HTMLReactParserOptions = {
  replace(domNode) {
    // Use a structural check rather than `instanceof Element` because
    // duplicated domhandler module instances make the class identity
    // unreliable, leaving `instanceof` false for real Element nodes.
    if (domNode.type !== 'tag') return;

    // Render mermaid diagrams from server-emitted placeholders
    if (domNode.name === 'div' && domNode.attribs.class === 'mermaid-diagram') {
      const source = domNode.attribs['data-mermaid-source'] ?? '';
      return <MermaidDiagram source={source} />;
    }

    // Replace internal <a> links with TanStack Router <Link>
    if (domNode.name === 'a' && domNode.attribs.href) {
      const href = domNode.attribs.href;
      if (isInternalLink(href)) {
        const props = attributesToProps(domNode.attribs);
        return (
          <Link to={href} {...props}>
            {domToReact(childrenToDOMNodes(domNode.children), parserOptions)}
          </Link>
        );
      }
    }

    // Add loading="lazy" to images, ensure alt is always set
    if (domNode.name === 'img') {
      const { alt = '', ...rest } = attributesToProps(
        domNode.attribs
      ) as React.ImgHTMLAttributes<HTMLImageElement>;
      return <img {...rest} alt={alt} loading="lazy" />;
    }
  },
};

export const MarkdownContent: React.FC<MarkdownContentProps> = ({
  markup,
  className,
}) => {
  return (
    <div className={`prose dark:prose-invert max-w-none ${className ?? ''}`}>
      {parse(markup, parserOptions)}
    </div>
  );
};
