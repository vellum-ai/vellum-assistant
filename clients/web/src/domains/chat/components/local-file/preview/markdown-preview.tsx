/**
 * Read-only view of a markdown workspace file (`.md`, `.markdown`) opened in
 * the document drawer.
 *
 * Rendered as formatted prose through the shared file-markdown renderer, the
 * same one the workspace browser and the skill views use, so one file reads
 * identically wherever it is opened.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import { FileMarkdown } from "@/components/file-markdown";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";

/**
 * Characters parsed and laid out at once. Markdown costs more per character
 * than plain text does (a parse, then a React tree), so the ceiling sits below
 * the plain-text one: past it the reader waits on the layout longer than the
 * tail of the file is worth.
 */
const MAX_DISPLAYED_CHARS = 512 * 1024;

const TRUNCATION_NOTICE = "Showing the first 512 KB";

/**
 * The slice of `markdown` the preview renders, and whether anything was left
 * off. Pure and exported so the boundary can be tested without a DOM.
 */
export function truncateForDisplay(markdown: string): {
  text: string;
  truncated: boolean;
} {
  if (markdown.length <= MAX_DISPLAYED_CHARS) {
    return { text: markdown, truncated: false };
  }
  return { text: markdown.slice(0, MAX_DISPLAYED_CHARS), truncated: true };
}

interface MarkdownPreviewProps {
  blob: Blob;
  filename: string;
}

export function MarkdownPreview({
  blob,
  filename,
}: MarkdownPreviewProps): ReactNode {
  const [text, setText] = useState<string | null>(null);
  const [decodeFailed, setDecodeFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setText(null);
    setDecodeFailed(false);
    // `Blob.text()` decodes as UTF-8, which is what the daemon writes and what
    // every other text surface in the app assumes.
    blob.text().then(
      (decoded) => {
        if (!cancelled) {
          setText(decoded);
        }
      },
      () => {
        if (!cancelled) {
          setDecodeFailed(true);
        }
      },
    );
    return () => {
      cancelled = true;
    };
  }, [blob]);

  const shown = useMemo(
    () => (text === null ? null : truncateForDisplay(text)),
    [text],
  );

  if (decodeFailed) {
    return <PreviewError filename={filename} />;
  }
  if (shown === null) {
    return <PreviewSkeleton />;
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <FileMarkdown content={shown.text} />
      {shown.truncated && (
        <Typography
          as="p"
          variant="label-small-default"
          className="border-t border-[var(--border-element)] pt-2 text-[var(--content-tertiary)]"
        >
          {TRUNCATION_NOTICE}
        </Typography>
      )}
    </div>
  );
}
