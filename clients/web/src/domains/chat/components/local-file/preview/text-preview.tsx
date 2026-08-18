/**
 * Read-only view of a plain-text workspace file (`.txt`, `.log`, `.json`,
 * `.yaml`, `.xml`) opened in the document drawer.
 *
 * The bytes render verbatim in a monospace block: these formats are read as
 * source, and re-flowing or highlighting them would be a claim about structure
 * the drawer has not parsed.
 */

import { type ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { useTruncatedBlobText } from "@/domains/chat/components/local-file/preview/use-truncated-blob-text";

/**
 * Bytes decoded and laid out at once. A log file runs to whatever length the
 * process that wrote it decided, and past a couple of megabytes the browser
 * spends longer laying the text out than the reader spends looking at the tail
 * of it.
 */
const MAX_DISPLAYED_BYTES = 2 * 1024 * 1024;

const TRUNCATION_NOTICE = "Showing the first 2 MB";

interface TextPreviewProps {
  blob: Blob;
  filename: string;
}

export function TextPreview({ blob, filename }: TextPreviewProps): ReactNode {
  const { text, truncated, decodeFailed } = useTruncatedBlobText(
    blob,
    MAX_DISPLAYED_BYTES,
  );

  if (decodeFailed) {
    return <PreviewError filename={filename} />;
  }
  if (text === null) {
    return <PreviewSkeleton />;
  }

  return (
    <div className="flex min-h-0 flex-col gap-2">
      <pre className="whitespace-pre-wrap break-words font-mono text-body-small-default text-[var(--content-default)]">
        {text}
      </pre>
      {truncated && (
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
