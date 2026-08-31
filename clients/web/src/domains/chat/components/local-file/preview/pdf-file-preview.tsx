/**
 * Read-only PDF view for the document drawer, rendered by the same canvas
 * pipeline the transcript's inline embeds and the attachment modal use, so a
 * file looks the same wherever it is opened.
 *
 * The renderer takes a URL, so the bytes the drawer already holds are wrapped
 * in an object URL rather than fetched a second time.
 */

import { type ReactNode } from "react";

import { PdfPageSkeleton } from "@/domains/chat/components/chat-attachments/pdf-page-skeleton";
import { PdfPreview } from "@/domains/chat/components/chat-attachments/pdf-preview";
import { PreviewError } from "@/domains/chat/components/local-file/preview/preview-error";
import { useBlobObjectUrl } from "@/domains/chat/components/local-file/use-local-file-info";

interface PdfFilePreviewProps {
  blob: Blob;
  filename: string;
}

export function PdfFilePreview({
  blob,
  filename,
}: PdfFilePreviewProps): ReactNode {
  const url = useBlobObjectUrl(blob, "application/pdf");

  // The page shape rather than the prose-line placeholder: this state runs
  // straight into `PdfPreview`'s own loading state, so a different shape here
  // would have the drawer swap placeholders on the way to the same document.
  if (url === null) {
    return <PdfPageSkeleton />;
  }

  return (
    // PdfPreview sizes its canvases and its loading placeholder for the
    // fullscreen modal (90vw); pin both to the drawer's width instead, or
    // the placeholder overflows a drawer a few hundred pixels wide and then
    // snaps smaller the moment the first canvas replaces it.
    <span className="block w-full [&_[data-slot=skeleton]]:w-full! [&_canvas]:w-full!">
      <PdfPreview
        url={url}
        errorFallback={<PreviewError filename={filename} />}
      />
    </span>
  );
}
