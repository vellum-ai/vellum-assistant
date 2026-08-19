import type { Surface } from "@/domains/chat/types/types";

import { DocumentCard } from "@/domains/chat/components/document-card";

interface DocumentPreviewSurfaceData {
  documentName: string;
  documentSurfaceId: string;
  content?: string;
  mimeType?: string;
}

interface DocumentPreviewSurfaceProps {
  surface: Surface;
  onAction: (
    surfaceId: string,
    actionId: string,
    data?: Record<string, unknown>,
  ) => void;
  onOpenDocument?: (documentSurfaceId: string) => void;
}

/**
 * A `document_preview` surface, drawn through the shared {@link DocumentCard}.
 *
 * The assistant transcript no longer renders this surface where its tool ran —
 * a turn's documents are collected into one affordance at the end of the
 * response instead (see `resolve-response-documents.ts`). This path remains for
 * a `document_preview` that arrives outside that projection, e.g. one the model
 * writes inline with a `ui_show` tag.
 */
export function DocumentPreviewSurface({
  surface,
  onAction,
  onOpenDocument,
}: DocumentPreviewSurfaceProps) {
  const data: DocumentPreviewSurfaceData = {
    documentName:
      (surface.data.documentName as string) ??
      (surface.data.title as string) ??
      "",
    documentSurfaceId: (surface.data.surfaceId as string) ?? "",
    content: surface.data.content as string | undefined,
    mimeType: surface.data.mimeType as string | undefined,
  };
  const openAction = surface.actions?.[0];
  const openDocument = onOpenDocument;
  const documentSurfaceId = data.documentSurfaceId;

  const handleOpen = openAction
    ? () => onAction(surface.surfaceId, openAction.id)
    : openDocument && documentSurfaceId
      ? () => openDocument(documentSurfaceId)
      : undefined;

  return (
    <DocumentCard
      documentName={data.documentName}
      mimeType={data.mimeType}
      content={data.content}
      onOpen={handleOpen}
      ariaLabel={`Open ${data.documentName}`}
    />
  );
}
