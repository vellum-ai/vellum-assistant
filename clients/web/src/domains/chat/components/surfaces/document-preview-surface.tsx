import type { Surface } from "@/domains/chat/types/types";
import { useTranslation } from "@/i18n";

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
 * The assistant transcript collects a turn's documents into one card per
 * document at the end of the response (see `resolve-response-artifacts.ts`),
 * dropping the `document_preview` blocks that name them while it groups.
 * This path serves a `document_preview` that arrives outside that projection,
 * such as one the model writes inline with a `ui_show` tag.
 */
export function DocumentPreviewSurface({
  surface,
  onAction,
  onOpenDocument,
}: DocumentPreviewSurfaceProps) {
  const { t } = useTranslation("chat");
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
      ariaLabel={t("documentPreviewSurface.openAria", { name: data.documentName })}
    />
  );
}
