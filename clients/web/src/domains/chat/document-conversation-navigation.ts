import type { Location, NavigateFunction } from "react-router";

import { useViewerStore } from "@/stores/viewer-store";
import type { DocumentContent } from "@/types/document-types";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";
import {
  DOCUMENT_RETURN_PARAM,
  documentReturnPath,
  hasDocumentReturnEntry,
} from "@/utils/document-navigation";

import { useUnseenDocumentChangesStore } from "./unseen-document-changes-store";

export {
  DOCUMENT_RETURN_PARAM,
  documentReturnPath,
} from "@/utils/document-navigation";

export const DOCUMENT_PARAM = "document";
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

/** Dismisses the drawer without leaving its conversation or retaining URL intent. */
export function closeDocumentInConversation(
  navigate: NavigateFunction,
  location: Pick<Location, "pathname" | "search" | "hash" | "state">,
): void {
  useViewerStore.getState().closeDocument();
  const params = new URLSearchParams(location.search);
  const documentParams = [
    DOCUMENT_PARAM,
    DOCUMENT_RETURN_PARAM,
    DOCUMENT_VIEW_PARAM,
  ];
  if (!documentParams.some((key) => params.has(key))) {
    return;
  }
  for (const key of documentParams) {
    params.delete(key);
  }
  void navigate(
    {
      pathname: location.pathname,
      search: params.toString(),
      hash: location.hash,
    },
    { replace: true, state: location.state },
  );
}

/** Pops a click-opened session, with a safe route fallback for direct links. */
export function returnFromDocument(
  navigate: NavigateFunction,
  surfaceId: string,
  returnTo: string,
  state: unknown,
): void {
  if (hasDocumentReturnEntry(state, surfaceId, returnTo)) {
    void navigate(-1);
  } else if (returnTo.startsWith(`${routes.conversations}/`)) {
    navigateToConversation(
      navigate,
      returnTo.slice(`${routes.conversations}/`.length).replace(/\/$/, ""),
      { silent: true, replace: true, destination: returnTo },
    );
  } else {
    void navigate(returnTo, { replace: true });
  }
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

export function markOpenedDocumentViewed(
  assistantId: string | null,
  surfaceId: string,
): void {
  const opened = useViewerStore.getState().openedDocumentState;
  if (
    opened?.source === "document" &&
    opened.assistantId === assistantId &&
    opened.surfaceId === surfaceId
  ) {
    useUnseenDocumentChangesStore.getState().clearDocumentEverywhere(surfaceId);
  }
}

/** Changes the presentation of an existing session without loading its document. */
export function setDocumentConversationPresentation(
  navigate: NavigateFunction,
  {
    assistantId,
    conversationId,
    surfaceId,
    returnTo,
    state,
    view,
  }: {
    assistantId: string | null;
    conversationId: string;
    surfaceId: string;
    returnTo: string;
    state: unknown;
    view: "document" | "chat";
  },
): void {
  useViewerStore.getState().setMainView(view);
  if (view === "document") {
    markOpenedDocumentViewed(assistantId, surfaceId);
  }
  void navigate(
    documentConversationUrl(conversationId, surfaceId, returnTo, view),
    { replace: true, state },
  );
}

export function showDocumentInConversation(
  document: DocumentContent,
  conversationId: string,
  assistantId: string,
  presentation: "document" | "chat" = "document",
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
  if (presentation === "document") {
    useUnseenDocumentChangesStore
      .getState()
      .clearDocumentEverywhere(document.surfaceId);
  } else {
    useViewerStore.getState().setMainView("chat");
  }
}

export function navigateToDocumentConversation(
  navigate: NavigateFunction,
  document: DocumentContent,
  conversationId: string,
  assistantId: string,
  returnTo?: string,
  replace = false,
  state?: unknown,
): void {
  navigateToConversation(navigate, conversationId, {
    silent: true,
    destination: documentConversationUrl(
      conversationId,
      document.surfaceId,
      returnTo,
    ),
    replace,
    state,
  });
  showDocumentInConversation(document, conversationId, assistantId);
}
