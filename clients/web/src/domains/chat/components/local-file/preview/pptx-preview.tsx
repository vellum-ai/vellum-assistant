/**
 * A workspace `.pptx` rendered read-only in the chat drawer.
 *
 * The sidebar is for reading a deck the assistant just mentioned without
 * leaving the conversation, so the viewer runs with `canEdit` off: slides
 * render and navigate, nothing can be changed. Editing is a deliberate step up
 * into the full-screen editor, which the drawer's Edit button takes you to.
 *
 * Lazy-loaded by the preview container — the PowerPoint reader pulls in a zip
 * reader and an OOXML parser, which have no business in the chat bundle for the
 * sessions that never open a deck.
 */

import type { ReactNode } from "react";
import { PowerPointViewer } from "pptx-react-viewer";

import { Typography } from "@vellumai/design-library";

import { usePptxBytes } from "@/domains/chat/components/local-file/pptx/use-pptx-bytes";
import { PreviewSkeleton } from "@/domains/chat/components/local-file/preview/preview-skeleton";

import "pptx-react-viewer/styles.css";

interface PptxPreviewProps {
  blob: Blob;
  filename: string;
}

export function PptxPreview({ blob, filename }: PptxPreviewProps): ReactNode {
  const state = usePptxBytes(blob);

  if (state.status === "loading") {
    return <PreviewSkeleton />;
  }
  if (state.status === "error") {
    return (
      <div
        role="alert"
        className="rounded-lg border border-[var(--border-element)] bg-[var(--surface-lift)] p-3"
      >
        <Typography
          as="span"
          variant="body-small-default"
          className="text-[var(--content-default)]"
        >
          Couldn&apos;t read this presentation
        </Typography>
      </div>
    );
  }

  return (
    <PowerPointViewer
      content={state.bytes}
      fileName={filename}
      canEdit={false}
      className="h-full w-full"
    />
  );
}
