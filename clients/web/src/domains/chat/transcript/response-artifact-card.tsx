/**
 * Renders one of a response's assets as the card that closes the response.
 *
 * The card is per kind (a document is a title row, an app is a thumbnail tile)
 * because they are different things to look at. What the registry
 * generalizes is the placement and uniqueness rule (`response-artifacts.ts`):
 * one card per asset, at the end of the response, never where its tool ran and
 * never twice.
 *
 * A kind whose opener was not handed down renders nothing, matching the rest of
 * the transcript: a card that opens nothing is not worth a row.
 */

import { AppReopenCard } from "@/domains/chat/transcript/app-reopen-card";
import { DocumentReopenLink } from "@/domains/chat/transcript/document-reopen-link";
import type { ResponseArtifact } from "@/domains/chat/transcript/response-artifacts";

export interface ResponseArtifactCardProps {
  artifact: ResponseArtifact;
  assistantId?: string | null;
  conversationId?: string | null;
  onOpenDocument?: (surfaceId: string) => void;
  onOpenApp?: (appId: string) => void;
}

export function ResponseArtifactCard({
  artifact,
  assistantId,
  conversationId,
  onOpenDocument,
  onOpenApp,
}: ResponseArtifactCardProps) {
  if (artifact.kind === "document") {
    return onOpenDocument ? (
      <DocumentReopenLink
        surfaceId={artifact.id}
        assistantId={assistantId}
        conversationId={conversationId}
        onOpenDocument={onOpenDocument}
      />
    ) : null;
  }

  return onOpenApp ? (
    <AppReopenCard
      appId={artifact.id}
      assistantId={assistantId}
      conversationId={conversationId}
      onOpenApp={onOpenApp}
    />
  ) : null;
}
