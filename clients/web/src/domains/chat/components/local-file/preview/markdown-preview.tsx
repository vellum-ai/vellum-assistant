/**
 * Read-only view of a markdown workspace file (`.md`, `.markdown`) opened in
 * the document drawer.
 *
 * Rendered as formatted prose through the shared file-markdown renderer, the
 * same one the workspace browser and the skill views use, so one file reads
 * identically wherever it is opened.
 */

import { type ReactNode } from "react";

import { FileMarkdown } from "@/components/file-markdown";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { PreviewTruncationNotice } from "@/domains/chat/components/local-file/preview/preview-truncation-notice";
import { useTruncatedBlobText } from "@/domains/chat/components/local-file/preview/use-truncated-blob-text";
import { useTranslation } from "@/i18n";

/**
 * Bytes decoded, parsed, and laid out at once. Markdown costs more per byte
 * than plain text does (a parse, then a React tree), so the ceiling sits below
 * the plain-text one: past it the reader waits on the layout longer than the
 * tail of the file is worth.
 */
const MAX_DISPLAYED_BYTES = 512 * 1024;

interface MarkdownPreviewProps {
  blob: Blob;
  filename: string;
}

export function MarkdownPreview({
  blob,
  filename,
}: MarkdownPreviewProps): ReactNode {
  const { t } = useTranslation("chat");
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
        <PreviewTruncationNotice>
          {t("previewTruncationNotice.markdown")}
        </PreviewTruncationNotice>
      )}
    </div>
  );
}
