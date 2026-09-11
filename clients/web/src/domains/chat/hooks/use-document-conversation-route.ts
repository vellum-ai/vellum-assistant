import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { documentsByIdGet } from "@/generated/daemon/sdk.gen";
import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import {
  documentRequestScope,
  resolveDocumentConversation,
} from "../document-conversation";
import {
  DOCUMENT_RETURN_PARAM,
  documentConversationUrl,
  getDocumentConversationRoute,
  showDocumentInConversation,
} from "../document-conversation-navigation";
import { useUnseenDocumentChangesStore } from "../unseen-document-changes-store";
import { waitForDocumentSaves } from "../api/document-save";

function markOpenedDocumentViewed(
  assistantId: string | null,
  surfaceId: string,
) {
  const opened = useViewerStore.getState().openedDocumentState;
  if (
    opened?.source === "document" &&
    opened.assistantId === assistantId &&
    opened.surfaceId === surfaceId
  ) {
    useUnseenDocumentChangesStore.getState().clearDocumentEverywhere(surfaceId);
  }
}

/** Owns document URL intent inside the existing conversation session. */
export function useDocumentConversationRoute() {
  const { t } = useTranslation("chat");
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { conversationId } = useParams<{ conversationId: string }>();
  const { search } = useLocation();
  const navigate = useNavigate();
  const readiness = useOrgHeaderReadiness();
  const { surfaceId, showingDocument, returnTo } =
    getDocumentConversationRoute(search);
  const lastSurfaceRef = useRef<string | null>(null);
  const scopeRef = useRef<ReturnType<typeof documentRequestScope> | null>(null);
  const showingDocumentRef = useRef(showingDocument);
  useEffect(() => {
    showingDocumentRef.current = showingDocument;
  }, [showingDocument]);
  const [attempt, setAttempt] = useState(0);
  const [status, setStatus] = useState<
    | { owner: string; kind: "loading" | "ready" }
    | { owner: string; kind: "error"; message: string }
    | null
  >(null);
  const owner = `${assistantId}:${conversationId}:${surfaceId}`;

  useEffect(() => {
    if (!surfaceId || !assistantId || !conversationId) {
      return;
    }
    if (readiness === "resolving") {
      return;
    }
    if (readiness === "unavailable") {
      setStatus({
        owner,
        kind: "error",
        message: t("documentConversation.unavailable"),
      });
      return;
    }
    const scope = documentRequestScope(assistantId);
    scopeRef.current = scope;
    useViewerStore.getState().openDocument();
    setStatus({ owner, kind: "loading" });
    void (async () => {
      try {
        await waitForDocumentSaves({ assistantId, surfaceId });
        if (!scope.isCurrent()) {
          return;
        }
        const { data } = await documentsByIdGet({
          path: { assistant_id: assistantId, id: surfaceId },
          throwOnError: true,
        });
        if (!scope.isCurrent()) {
          return;
        }
        const linkedId = await resolveDocumentConversation({
          assistantId,
          document: data,
          isCurrent: scope.isCurrent,
        });
        if (!scope.isCurrent()) {
          return;
        }
        if (linkedId !== conversationId) {
          const params = new URLSearchParams({
            [DOCUMENT_RETURN_PARAM]: returnTo,
          });
          void navigate(`${routes.document(surfaceId)}?${params}`, {
            replace: true,
          });
          return;
        }
        showDocumentInConversation(
          data,
          conversationId,
          assistantId,
          showingDocumentRef.current ? "document" : "chat",
        );
        setStatus({ owner, kind: "ready" });
      } catch (error) {
        if (scope.isCurrent()) {
          captureError(error, { context: "document_conversation_route" });
          setStatus({
            owner,
            kind: "error",
            message: t("documentConversation.unavailable"),
          });
        }
      }
    })();
    return scope.dispose;
  }, [
    assistantId,
    conversationId,
    surfaceId,
    readiness,
    owner,
    navigate,
    returnTo,
    attempt,
    t,
  ]);

  useEffect(() => {
    if (surfaceId) {
      useViewerStore
        .getState()
        .setMainView(showingDocument ? "document" : "chat");
      if (showingDocument) {
        markOpenedDocumentViewed(assistantId, surfaceId);
      }
    } else if (lastSurfaceRef.current) {
      useViewerStore.getState().closeDocument();
    }
    lastSurfaceRef.current = surfaceId;
  }, [surfaceId, showingDocument, assistantId]);

  const closeDocument = useCallback(() => {
    scopeRef.current?.dispose();
    useViewerStore.getState().closeDocument();
    if (returnTo.startsWith(`${routes.conversations}/`)) {
      navigateToConversation(
        navigate,
        returnTo.slice(`${routes.conversations}/`.length),
        { silent: true, replace: true },
      );
    } else {
      void navigate(returnTo, { replace: true });
    }
  }, [navigate, returnTo]);

  const setPresentation = useCallback(
    (view: "document" | "chat") => {
      if (!conversationId || !surfaceId) {
        return;
      }
      useViewerStore.getState().setMainView(view);
      if (view === "document") {
        markOpenedDocumentViewed(assistantId, surfaceId);
      }
      void navigate(
        documentConversationUrl(conversationId, surfaceId, returnTo, view),
        { replace: true },
      );
    },
    [conversationId, surfaceId, navigate, returnTo, assistantId],
  );
  const viewConversation = useCallback(
    () => setPresentation("chat"),
    [setPresentation],
  );
  const reopenDocument = useCallback(
    () => setPresentation("document"),
    [setPresentation],
  );
  const reloadDocument = useCallback(
    () => setAttempt((value) => value + 1),
    [],
  );

  return {
    surfaceId,
    showingDocument,
    isLoading:
      Boolean(surfaceId) &&
      (status?.owner !== owner || status.kind === "loading"),
    error:
      status?.owner === owner && status.kind === "error"
        ? status.message
        : null,
    closeDocument,
    viewConversation,
    reopenDocument,
    reloadDocument,
  };
}
