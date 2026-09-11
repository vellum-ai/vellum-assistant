import type { NavigateFunction } from "react-router";

import { useViewerStore } from "@/stores/viewer-store";
import type { DocumentContent } from "@/types/document-types";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import { useUnseenDocumentChangesStore } from "./unseen-document-changes-store";

export const DOCUMENT_PARAM = "document";
export const DOCUMENT_RETURN_PARAM = "documentReturn";
export const DOCUMENT_VIEW_PARAM = "documentView";

export function getDocumentConversationRoute(search: string) {
  const params = new URLSearchParams(search);
  const surfaceId = params.get(DOCUMENT_PARAM) || null;
  return {
    surfaceId,
    showingDocument:
      surfaceId !== null && params.get(DOCUMENT_VIEW_PARAM) !== "chat",
    returnTo: documentReturnPath(params.get(DOCUMENT_RETURN_PARAM)),
  };
}

/** Only the two document entry surfaces are valid return destinations. */
export function documentReturnPath(value?: string | null): string {
  if (
    value === routes.library.root ||
    /^\/assistant\/conversations\/[^/?#\\]+$/.test(value ?? "")
  ) {
    return value!;
  }
  return routes.library.root;
}

export function documentConversationUrl(
  conversationId: string,
  surfaceId: string,
  returnTo?: string,
  view: "document" | "chat" = "document",
  prompt?: string,
): string {
  const params = new URLSearchParams({
    [DOCUMENT_PARAM]: surfaceId,
    [DOCUMENT_RETURN_PARAM]: documentReturnPath(returnTo),
  });
  if (view === "chat") {
    params.set(DOCUMENT_VIEW_PARAM, "chat");
  }
  if (prompt) {
    params.set("prompt", prompt);
  }
  return `${routes.conversation(conversationId)}?${params}`;
}

export function showDocumentInConversation(
  document: DocumentContent,
  conversationId: string,
  assistantId: string,
): void {
  useViewerStore.getState().openDocument();
  useViewerStore.setState({
    activeDocumentTarget: { source: "document", surfaceId: document.surfaceId },
  });
  useViewerStore.getState().setLoadedDocument({
    source: "document",
    assistantId,
    surfaceId: document.surfaceId,
    conversationId,
    documentName: document.title,
    content: document.content,
  });
  useUnseenDocumentChangesStore
    .getState()
    .clearDocumentEverywhere(document.surfaceId);
}

export function navigateToDocumentConversation(
  navigate: NavigateFunction,
  document: DocumentContent,
  conversationId: string,
  assistantId: string,
  returnTo?: string,
  replace = false,
): void {
  navigateToConversation(navigate, conversationId, {
    silent: true,
    destination: documentConversationUrl(
      conversationId,
      document.surfaceId,
      returnTo,
    ),
    replace,
  });
  showDocumentInConversation(document, conversationId, assistantId);
}
