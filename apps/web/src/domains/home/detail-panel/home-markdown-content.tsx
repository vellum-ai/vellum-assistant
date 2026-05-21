import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import remarkGfm from "remark-gfm";

import { cn } from "@vellum/design-library";

interface HomeMarkdownContentProps {
  content: string;
  className?: string;
}

/**
 * `react-markdown` overrides for the home feed detail panel. Uses
 * the same design-token styling as the file-viewer markdown but
 * with tighter spacing suited to the condensed panel layout.
 */
const markdownComponents: Components = {
  p: ({ children }) => (
    <p
      className="mb-2 text-body-medium-default last:mb-0"
      style={{ color: "var(--content-secondary)" }}
    >
      {children}
    </p>
  ),
  strong: ({ children }) => (
    <strong style={{ color: "var(--content-default)" }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em style={{ color: "var(--content-default)" }}>{children}</em>
  ),
  a: ({ href, children }) => (
    <a
      href={href}
      className="underline"
      style={{ color: "var(--content-link)" }}
      target="_blank"
      rel="noopener noreferrer"
    >
      {children}
    </a>
  ),
  ul: ({ children }) => (
    <ul
      className="mb-2 list-disc pl-5 text-body-medium-default"
      style={{ color: "var(--content-secondary)" }}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol
      className="mb-2 list-decimal pl-5 text-body-medium-default"
      style={{ color: "var(--content-secondary)" }}
    >
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  code: ({ children }) => (
    <code
      className="rounded px-1 py-0.5 font-mono text-[0.85em]"
      style={{
        backgroundColor:
          "color-mix(in oklab, var(--content-default) 8%, transparent)",
        color: "var(--content-default)",
      }}
    >
      {children}
    </code>
  ),
  h1: ({ children }) => (
    <h1
      className="mb-2 text-title-medium first:mt-0"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </h1>
  ),
  h2: ({ children }) => (
    <h2
      className="mb-2 text-title-small first:mt-0"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </h2>
  ),
  h3: ({ children }) => (
    <h3
      className="mb-1 text-body-medium-default first:mt-0"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </h3>
  ),
  blockquote: ({ children }) => (
    <blockquote
      className="mb-2 border-l-2 pl-3 text-body-medium-default"
      style={{
        borderColor: "var(--border-base)",
        color: "var(--content-tertiary)",
      }}
    >
      {children}
    </blockquote>
  ),
};

/**
 * Lightweight markdown renderer for home feed detail panel content.
 * Supports GFM (bold, italic, links, lists, tables, strikethrough)
 * with styling consistent with the home feed's design tokens.
 */
export function HomeMarkdownContent({
  content,
  className,
}: HomeMarkdownContentProps) {
  return (
    <div className={cn("text-body-medium-default", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
