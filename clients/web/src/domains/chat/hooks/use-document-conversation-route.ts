import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore, type DocumentTarget } from "@/stores/viewer-store";
import { documentEntryUrl } from "@/utils/document-navigation";

import {
  documentRequestScope,
  resolveDocumentConversation,
} from "../document-conversation";
import {
  clearDocumentConversationUrl,
  closeDocumentInConversation,
  getDocumentConversationRoute,
  markOpenedDocumentViewed,
  setDocumentConversationPresentation,
  showDocumentInConversation,
  returnFromDocument,
} from "../document-conversation-navigation";
import { loadDocumentContent } from "../api/document-load";
import { useOverlayEscape } from "./use-overlay-escape";

/** Owns document URL intent inside the existing conversation session. */
export function useDocumentConversationRoute() {
  const { t } = useTranslation("chat");
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const { conversationId } = useParams<{ conversationId: string }>();
  const location = useLocation();
  const { pathname, search, state: navigationState } = location;
  const navigate = useNavigate();
  const readiness = useOrgHeaderReadiness();
  const isMobile = useIsMobile();
  const { surfaceId, showingDocument, returnTo } =
    getDocumentConversationRoute(search);
  const lastSurfaceRef = useRef<string | null>(null);
  const ownedTargetRef = useRef<DocumentTarget | null>(null);
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
  const owner = `${assistantId}:${conversationId}:${surfaceId}:${isMobile}`;
  const wasMobileRef = useRef(isMobile);

  const clearOwnedDocument = useCallback(() => {
    const target = ownedTargetRef.current;
    ownedTargetRef.current = null;
    const viewer = useViewerStore.getState();
    // Reference identity protects a newer entry, even for the same surface.
    if (target === null || viewer.activeDocumentTarget !== target) {
      return;
    }
    useViewerStore.setState({
      mainView:
        viewer.mainView === "document"
          ? viewer.viewBeforeDocument
          : viewer.mainView,
      openedDocumentState: null,
      activeDocumentTarget: null,
    });
  }, []);

  useEffect(() => clearOwnedDocument, [clearOwnedDocument]);

  useEffect(() => {
    if (isMobile || !surfaceId || !showingDocument) {
      return;
    }
    return useViewerStore.subscribe((viewer, previous) => {
      const target = ownedTargetRef.current;
      if (
        previous.mainView !== "document" ||
        viewer.mainView === "document" ||
        viewer.mainView === "chat" ||
        target === null ||
        viewer.activeDocumentTarget !== target
      ) {
        return;
      }
      scopeRef.current?.dispose();
      clearOwnedDocument();
      clearDocumentConversationUrl(navigate, location);
    });
  }, [
    isMobile,
    surfaceId,
    showingDocument,
    clearOwnedDocument,
    navigate,
    location,
  ]);

  useEffect(() => {
    const wasMobile = wasMobileRef.current;
    wasMobileRef.current = isMobile;
    if (wasMobile || !isMobile || surfaceId || !assistantId) {
      return;
    }
    const viewer = useViewerStore.getState();
    const opened = viewer.openedDocumentState;
    if (
      viewer.mainView !== "document" ||
      opened?.source !== "document" ||
      opened.assistantId !== assistantId
    ) {
      return;
    }
    void navigate(documentEntryUrl(opened.surfaceId, pathname), {
      replace: true,
    });
  }, [isMobile, surfaceId, assistantId, pathname, navigate]);

  useEffect(() => {
    if (!surfaceId || !assistantId || !conversationId) {
      return;
    }
    const target: DocumentTarget = { source: "document", surfaceId };
    ownedTargetRef.current = target;
    useViewerStore.setState({ activeDocumentTarget: target });
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
        const data = await loadDocumentContent({
          assistantId,
          surfaceId,
          isCurrent: scope.isCurrent,
        });
        if (!data || !scope.isCurrent()) {
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
          void navigate(documentEntryUrl(surfaceId, returnTo), {
            replace: true,
            state: navigationState,
          });
          return;
        }
        showDocumentInConversation(
          data,
          conversationId,
          assistantId,
          showingDocumentRef.current ? "document" : "chat",
        );
        ownedTargetRef.current = useViewerStore.getState().activeDocumentTarget;
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
    navigationState,
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
      clearOwnedDocument();
    }
    lastSurfaceRef.current = surfaceId;
  }, [surfaceId, showingDocument, assistantId, clearOwnedDocument]);

  const closeDocument = useCallback(() => {
    scopeRef.current?.dispose();
    if (!isMobile) {
      closeDocumentInConversation(navigate, location);
      return;
    }
    useViewerStore.getState().closeDocument();
    returnFromDocument(navigate, surfaceId ?? "", returnTo, navigationState);
  }, [navigate, surfaceId, returnTo, navigationState, isMobile, location]);

  useOverlayEscape(isMobile && !!surfaceId && showingDocument, () => {
    if (useViewerStore.getState().mainView !== "document") {
      return false;
    }
    closeDocument();
    return true;
  });

  const setPresentation = useCallback(
    (view: "document" | "chat") => {
      if (!conversationId || !surfaceId) {
        return;
      }
      setDocumentConversationPresentation(navigate, {
        assistantId,
        conversationId,
        surfaceId,
        returnTo,
        state: navigationState,
        view,
      });
    },
    [
      conversationId,
      surfaceId,
      navigate,
      returnTo,
      assistantId,
      navigationState,
    ],
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
