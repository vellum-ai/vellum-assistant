/**
 * Markdown FILE content: a README, a skill's instructions, a note.
 *
 * The rendering itself is `MarkdownMessage`, so a file and a chat message go
 * through one renderer rather than two that drift. This wrapper is where the
 * decisions that make content a file rather than a message are written down
 * once, and it supplies what only the app knows: links open through
 * `ExternalAnchor`, which the native shells need to open a link at all.
 */

import { MarkdownMessage } from "@vellumai/design-library";

import { ExternalAnchor } from "@/components/external-anchor";

/**
 * True if the file looks like markdown by name or mime type.
 * Recognised extensions: `.md`, `.markdown`. Recognised mime: `text/markdown`.
 */
export function isMarkdown(
  name: string | undefined,
  mimeType: string | undefined,
): boolean {
  if (mimeType === "text/markdown") {
    return true;
  }
  const lower = (name ?? "").toLowerCase();
  return lower.endsWith(".md") || lower.endsWith(".markdown");
}

function FileLink({
  href,
  children,
}: {
  href?: string;
  children?: React.ReactNode;
}) {
  return (
    <ExternalAnchor href={href} tone="default">
      {children}
    </ExternalAnchor>
  );
}

export function FileMarkdown({ content }: { content: string }) {
  return (
    <MarkdownMessage
      content={content}
      linkComponent={FileLink}
      // What a file is, decision by decision: its embedded HTML is layout it
      // wrote for itself, its images are its own, its `$` is a shell variable
      // or a price, and its leading YAML block is metadata about it.
      parseHtml
      remoteImages
      math={false}
      frontmatter="metadata"
    />
  );
}
