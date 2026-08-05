/**
 * Read-only view of a plain-text workspace file (`.txt`, `.log`, `.json`,
 * `.yaml`, `.xml`) opened in the document drawer.
 *
 * The bytes render verbatim in a monospace block: these formats are read as
 * source, and re-flowing or highlighting them would be a claim about structure
 * the drawer has not parsed.
 */

import { useEffect, useMemo, useState, type ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";

/**
 * Characters laid out at once. A log file runs to whatever length the process
 * that wrote it decided, and past a couple of megabytes the browser spends
 * longer laying the text out than the reader spends looking at the tail of it.
 */
const MAX_DISPLAYED_CHARS = 2 * 1024 * 1024;

const TRUNCATION_NOTICE = "Showing the first 2 MB";

/**
 * The slice of `text` the preview lays out, and whether anything was left off.
 * Pure and exported so the boundary can be tested without a DOM.
 */
export function truncateForDisplay(text: string): {
  text: string;
  truncated: boolean;
} {
  if (text.length <= MAX_DISPLAYED_CHARS) {
    return { text, truncated: false };
  }
  return { text: text.slice(0, MAX_DISPLAYED_CHARS), truncated: true };
}

interface TextPreviewProps {
  blob: Blob;
  filename: string;
}

export function TextPreview({ blob, filename }: TextPreviewProps): ReactNode {
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
      <pre className="whitespace-pre-wrap break-words font-mono text-body-small-default text-[var(--content-default)]">
        {shown.text}
      </pre>
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
