/**
 * Shared helpers and `react-markdown` component overrides for rendering
 * markdown FILE content (as opposed to chat messages).
 *
 * Used by skill detail views and workspace file viewers.
 * For chat-style markdown rendering, see `MarkdownMessage` instead.
 */

import ReactMarkdown from "react-markdown";
import type { Components } from "react-markdown";
import rehypeRaw from "rehype-raw";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";

/**
 * True if the file looks like markdown by name or mime type.
 * Recognised extensions: `.md`, `.markdown`. Recognised mime: `text/markdown`.
 */
export function isMarkdown(
  name: string | undefined,
  mimeType: string | undefined,
): boolean {
  if (mimeType === "text/markdown") return true;
  const lower = (name ?? "").toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

/**
 * Strip a leading YAML frontmatter block (`---\n...\n---\n`) from markdown
 * content. Frontmatter is metadata for the surrounding system and not meant
 * for the reader.
 */
export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

/**
 * `react-markdown` component overrides tuned for FILE viewing — generous
 * heading scale, document-style spacing, and design-token colours.
 */
export const fileMarkdownComponents: Components = {
  h1: ({ node: _node, children, ...rest }) => (
    <h1
      {...rest}
      className="mb-3 mt-4 text-title-large first:mt-0"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </h1>
  ),
  h2: ({ node: _node, children, ...rest }) => (
    <h2
      {...rest}
      className="mb-2 mt-5 border-b pb-1 text-title-medium first:mt-0"
      style={{
        color: "var(--content-default)",
        borderColor: "var(--border-base)",
      }}
    >
      {children}
    </h2>
  ),
  h3: ({ node: _node, children, ...rest }) => (
    <h3
      {...rest}
      className="mb-2 mt-4 text-title-small first:mt-0"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </h3>
  ),
  h4: ({ node: _node, children, ...rest }) => (
    <h4
      {...rest}
      className="mb-1 mt-3 text-body-medium-default first:mt-0"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </h4>
  ),
  p: ({ node: _node, children, ...rest }) => (
    <p
      {...rest}
      className="mb-3 text-body-medium-lighter last:mb-0"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </p>
  ),
  ul: ({ children }) => (
    <ul
      className="mb-3 list-disc pl-6 text-body-medium-lighter last:mb-0"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </ul>
  ),
  ol: ({ children }) => (
    <ol
      className="mb-3 list-decimal pl-6 text-body-medium-lighter last:mb-0"
      style={{ color: "var(--content-default)" }}
    >
      {children}
    </ol>
  ),
  li: ({ children }) => <li className="mb-0.5">{children}</li>,
  a: ({ href, children }) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      className="underline"
      style={{ color: "var(--primary-base, #60a5fa)" }}
    >
      {children}
    </a>
  ),
  strong: ({ children }) => (
    <strong style={{ color: "var(--content-default)" }}>{children}</strong>
  ),
  em: ({ children }) => (
    <em style={{ color: "var(--content-default)" }}>{children}</em>
  ),
  code: ({ node: _node, className, children, ...rest }) => {
    const isBlock = className?.startsWith("language-");
    if (isBlock) {
      return (
        <code
          {...rest}
          className={`block overflow-x-auto rounded p-3 font-mono text-body-small-default ${className ?? ""}`}
          style={{
            backgroundColor:
              "color-mix(in oklab, var(--content-default) 8%, transparent)",
            color: "var(--content-default)",
          }}
        >
          {children}
        </code>
      );
    }
    return (
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
    );
  },
  pre: ({ children }) => (
    <pre
      className="mb-3 overflow-x-auto rounded-md p-3 text-body-small-default last:mb-0"
      style={{
        backgroundColor:
          "color-mix(in oklab, var(--content-default) 8%, transparent)",
      }}
    >
      {children}
    </pre>
  ),
  blockquote: ({ children }) => (
    <blockquote
      className="mb-3 border-l-2 pl-3 italic last:mb-0"
      style={{
        borderColor: "var(--primary-base, #3b82f6)",
        color: "var(--content-secondary, var(--content-tertiary))",
      }}
    >
      {children}
    </blockquote>
  ),
  table: ({ children }) => (
    <div className="mb-3 overflow-x-auto last:mb-0">
      <table className="min-w-full border-collapse text-body-small-default">
        {children}
      </table>
    </div>
  ),
  th: ({ node: _node, children, ...rest }) => (
    <th
      {...rest}
      className="border px-2 py-1 text-left text-body-small-emphasised"
      style={{
        borderColor: "var(--border-base)",
        color: "var(--content-default)",
      }}
    >
      {children}
    </th>
  ),
  td: ({ node: _node, children, ...rest }) => (
    <td
      {...rest}
      className="border px-2 py-1"
      style={{
        borderColor: "var(--border-base)",
        color: "var(--content-default)",
      }}
    >
      {children}
    </td>
  ),
  hr: () => (
    <hr className="my-4" style={{ borderColor: "var(--border-base)" }} />
  ),
};

interface FileMarkdownProps {
  content: string;
  /**
   * When true (default), a leading YAML frontmatter block is stripped before
   * rendering. Set to `false` for content where a leading frontmatter block
   * is real, reader-facing content rather than metadata.
   */
  stripFrontmatter?: boolean;
  /**
   * When true (default), inline HTML embedded in the markdown is parsed into
   * real elements (then sanitized). Set to `false` for content where
   * XML/HTML-style tags are literal text that must stay visible — e.g. LLM
   * prompt text using `<instructions>`-style delimiters.
   */
  parseHtml?: boolean;
}

/**
 * Render markdown file content with the file-viewer component scale.
 * Strips a leading YAML frontmatter block by default; pass
 * `stripFrontmatter={false}` to preserve it.
 */
export function FileMarkdown({
  content,
  stripFrontmatter: shouldStripFrontmatter = true,
  parseHtml = true,
}: FileMarkdownProps) {
  const rendered = shouldStripFrontmatter ? stripFrontmatter(content) : content;
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      // `rehype-raw` reparses inline HTML embedded in markdown (READMEs often
      // use `<p align>`, `<img>`, `<table>` for layout), then `rehype-sanitize`
      // strips anything unsafe (scripts, event handlers, `javascript:` URLs)
      // using its GitHub-aligned default schema. Order matters: raw first so
      // sanitize sees real element nodes. Without `parseHtml`, react-markdown
      // renders raw HTML as literal text instead.
      rehypePlugins={parseHtml ? [rehypeRaw, rehypeSanitize] : []}
      components={fileMarkdownComponents}
    >
      {rendered}
    </ReactMarkdown>
  );
}
