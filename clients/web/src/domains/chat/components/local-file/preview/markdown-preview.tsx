/**
 * Read-only view of a markdown workspace file (`.md`, `.markdown`) opened in
 * the document drawer.
 *
 * Rendered as formatted prose through the shared file-markdown renderer, the
 * same one the workspace browser and the skill views use, so one file reads
 * identically wherever it is opened.
 */

import { type ReactNode } from "react";

import { Typography } from "@vellumai/design-library";

import { FileMarkdown } from "@/components/file-markdown";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { useTruncatedBlobText } from "@/domains/chat/components/local-file/preview/use-truncated-blob-text";

/**
 * Bytes decoded, parsed, and laid out at once. Markdown costs more per byte
 * than plain text does (a parse, then a React tree), so the ceiling sits below
 * the plain-text one: past it the reader waits on the layout longer than the
 * tail of the file is worth.
 */
const MAX_DISPLAYED_BYTES = 512 * 1024;

const TRUNCATION_NOTICE = "Showing the first 512 KB";

interface MarkdownPreviewProps {
  blob: Blob;
  filename: string;
}

export function MarkdownPreview({
  blob,
  filename,
}: MarkdownPreviewProps): ReactNode {
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
      <FileMarkdown content={text} />
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
