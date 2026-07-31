/**
 * Read-only PDF view for the document drawer, rendered by the same canvas
 * pipeline the transcript's inline embeds and the attachment modal use, so a
 * file looks the same wherever it is opened.
 *
 * The renderer takes a URL, so the bytes the drawer already holds are wrapped
 * in an object URL rather than fetched a second time.
 */

import { type ReactNode } from "react";

import { PdfPreview } from "@/domains/chat/components/chat-attachments/pdf-preview";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";
import { useBlobObjectUrl } from "@/domains/chat/components/local-file/use-local-file-info";

interface PdfFilePreviewProps {
  blob: Blob;
}

export function PdfFilePreview({ blob }: PdfFilePreviewProps): ReactNode {
  const url = useBlobObjectUrl(blob, "application/pdf");

  if (url === null) {
    return <PreviewSkeleton />;
  }

  return (
    // PdfPreview sizes its canvases for the fullscreen modal (90vw); pin them
    // to the drawer's width instead.
    <span className="block w-full [&_canvas]:w-full!">
      <PdfPreview url={url} />
    </span>
  );
}
