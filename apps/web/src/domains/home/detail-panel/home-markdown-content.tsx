import type { MouseEvent } from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { openUrl } from "@/runtime/browser";
import { isNativePlatform } from "@/runtime/native-auth";
import { cn } from "@vellumai/design-library";

interface HomeMarkdownContentProps {
  content: string;
  className?: string;
}

// On iOS WKWebView without a `WKUIDelegate createWebViewWith` implementation,
// `target="_blank"` links silently do nothing — the webview won't open a new
// "tab". Route through Capacitor's `SFSafariViewController` instead so the
// user actually sees the destination. Web keeps the default new-tab behavior
// (right-click → copy link still works because the `href` is preserved).
function handleAnchorClick(
  event: MouseEvent<HTMLAnchorElement>,
  href: string | undefined,
): void {
  if (!href || !isNativePlatform()) return;
  event.preventDefault();
  void openUrl(href);
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
      onClick={(e) => handleAnchorClick(e, href)}
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
  // Wraps fenced code blocks. `react-markdown` nests <code> inside <pre>
  // for ``` blocks, so we override the wrapper here to give the block its
  // own padding/scroll instead of inheriting the inline-code chip styling.
  pre: ({ children }) => (
    <pre
      className="mb-2 overflow-x-auto rounded p-3 font-mono text-[0.85em]"
      style={{
        backgroundColor:
          "color-mix(in oklab, var(--content-default) 6%, transparent)",
        color: "var(--content-default)",
      }}
    >
      {children}
    </pre>
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
  // GFM tables — without these, browser-default rendering produces unstyled
  // borders that don't match the rest of the panel. Horizontal scroll keeps
  // wide tables from blowing out the condensed panel width.
  table: ({ children }) => (
    <div className="mb-2 overflow-x-auto">
      <table
        className="w-full border-collapse text-body-small-default"
        style={{ color: "var(--content-secondary)" }}
      >
        {children}
      </table>
    </div>
  ),
  thead: ({ children }) => (
    <thead style={{ backgroundColor: "var(--surface-lift)" }}>{children}</thead>
  ),
  tbody: ({ children }) => <tbody>{children}</tbody>,
  tr: ({ children }) => (
    <tr style={{ borderBottom: "1px solid var(--border-base)" }}>{children}</tr>
  ),
  th: ({ children }) => (
    <th
      className="px-2 py-1.5 text-left font-semibold"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-2 py-1.5 align-top">{children}</td>,
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
