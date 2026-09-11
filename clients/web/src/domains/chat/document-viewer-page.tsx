import { Button, Typography } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { documentsByIdGet } from "@/generated/daemon/sdk.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useEdgeSwipeBack } from "@/hooks/use-edge-swipe-back";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useOrgHeaderReadiness } from "@/hooks/use-is-org-ready";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import type { DocumentContent } from "@/types/document-types";
import { navigateToConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

import {
  DocumentViewerContainer,
  type DocumentViewerContainerHandle,
} from "./components/document-viewer-container";
import {
  documentRequestScope,
  getDocumentFeedbackPrompt,
  resolveDocumentConversation,
  startDocumentConversation,
} from "./document-conversation";
import {
  documentReturnPath,
  documentConversationUrl,
  DOCUMENT_RETURN_PARAM,
  navigateToDocumentConversation,
  showDocumentInConversation,
} from "./document-conversation-navigation";
import { useDocumentCommentEvents } from "./hooks/use-document-comment-events";
import { useDocumentPdfExport } from "./hooks/use-document-pdf-export";
import { useUnseenDocumentChangesStore } from "./unseen-document-changes-store";

type DocumentPageState =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "ready"; doc: DocumentContent; needsConversation: boolean };

/** Desktop document viewer and mobile adapter into the linked chat session. */
export function DocumentViewerPage() {
  const { t } = useTranslation("chat");
  const { surfaceId } = useParams<{ surfaceId: string }>();
  const navigate = useNavigate();
  const { pathname, search } = useLocation();
  const isMobile = useIsMobile();
  // The route host stays stable while the user edits, even across a breakpoint.
  const [entryMode] = useState(isMobile ? "conversation" : "standalone");
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantsHydrated =
    useResolvedAssistantsStore.use.assistantsHydrated();
  const readiness = useOrgHeaderReadiness();
  const returnTo = documentReturnPath(
    new URLSearchParams(search).get(DOCUMENT_RETURN_PARAM),
  );
  const swipeContainerRef = useRef<HTMLDivElement>(null);
  const viewerRef = useRef<DocumentViewerContainerHandle>(null);
  const requestRef = useRef<ReturnType<typeof documentRequestScope> | null>(
    null,
  );
  const [state, setState] = useState<DocumentPageState>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  const [preparing, setPreparing] = useState(false);
  const preparingRef = useRef(false);
  const doc = state.kind === "ready" ? state.doc : null;
  const handleExport = useDocumentPdfExport(
    assistantId,
    doc?.surfaceId ?? null,
    doc?.title,
  );

  useEffect(() => {
    setState({ kind: "loading" });
    preparingRef.current = false;
    setPreparing(false);
    if (
      !surfaceId ||
      (!assistantId && assistantsHydrated) ||
      readiness === "unavailable"
    ) {
      setState({ kind: "error" });
      return;
    }
    if (!assistantId || readiness !== "ready") {
      return;
    }
    const scope = documentRequestScope(assistantId);
    requestRef.current = scope;
    void (async () => {
      try {
        const { data } = await documentsByIdGet({
          path: { assistant_id: assistantId, id: surfaceId },
          throwOnError: true,
        });
        if (!scope.isCurrent()) {
          return;
        }
        if (entryMode === "conversation") {
          const linkedId = await resolveDocumentConversation({
            assistantId,
            document: data,
            isCurrent: scope.isCurrent,
          });
          if (!scope.isCurrent()) {
            return;
          }
          if (linkedId) {
            navigateToDocumentConversation(
              navigate,
              data,
              linkedId,
              assistantId,
              returnTo,
              true,
            );
            return;
          }
        }
        useUnseenDocumentChangesStore
          .getState()
          .clearDocumentEverywhere(surfaceId);
        setState({
          kind: "ready",
          doc: data,
          needsConversation: entryMode === "conversation",
        });
      } catch (error) {
        if (scope.isCurrent()) {
          captureError(error, { context: "document_viewer_page" });
          setState({ kind: "error" });
        }
      }
    })();
    return scope.dispose;
  }, [
    surfaceId,
    assistantId,
    assistantsHydrated,
    readiness,
    entryMode,
    navigate,
    returnTo,
    attempt,
  ]);

  const handleCommentsChanged = useCallback(() => {
    void viewerRef.current?.refreshComments();
  }, []);
  const handleSseEvent = useDocumentCommentEvents({
    surfaceId: surfaceId ?? "",
    enabled: Boolean(surfaceId),
    onCommentsChanged: handleCommentsChanged,
  });
  useBusSubscription("sse.event", handleSseEvent);

  const handleClose = useCallback(() => {
    requestRef.current?.dispose();
    void navigate(returnTo, { replace: true });
  }, [navigate, returnTo]);
  useEdgeSwipeBack({
    containerRef: swipeContainerRef,
    onBack: handleClose,
    enabled: isMobile,
    navKey: pathname,
  });

  const prepareConversation = useCallback(
    async (feedback: boolean) => {
      if (!doc || !assistantId || preparingRef.current || !viewerRef.current) {
        return;
      }
      const scope = requestRef.current;
      if (!scope?.isCurrent()) {
        return;
      }
      preparingRef.current = true;
      setPreparing(true);
      const barrier = viewerRef.current.beginSendPreparation();
      try {
        const saved = await barrier.flush();
        if (!scope.isCurrent() || !barrier.isCurrent()) {
          return;
        }
        const latestDocument = { ...doc, ...saved };
        const options = {
          assistantId,
          document: latestDocument,
          isCurrent: scope.isCurrent,
        };
        const conversationId =
          (await resolveDocumentConversation(options)) ??
          (await startDocumentConversation(options));
        if (!conversationId || !scope.isCurrent() || !barrier.isCurrent()) {
          return;
        }
        if (feedback) {
          showDocumentInConversation(
            latestDocument,
            conversationId,
            assistantId,
          );
          navigateToConversation(navigate, conversationId, {
            silent: true,
            destination: isMobile
              ? documentConversationUrl(
                  conversationId,
                  doc.surfaceId,
                  returnTo,
                  "chat",
                  getDocumentFeedbackPrompt(latestDocument.title),
                )
              : routes.conversationWithPrompt(
                  conversationId,
                  getDocumentFeedbackPrompt(latestDocument.title),
                ),
          });
          if (!isMobile) {
            useViewerStore.getState().setMainView("document");
          }
        } else {
          navigateToDocumentConversation(
            navigate,
            latestDocument,
            conversationId,
            assistantId,
            returnTo,
            true,
          );
        }
      } catch (error) {
        if (scope.isCurrent()) {
          captureError(error, { context: "document_prepare_conversation" });
          toast.error(t("documentConversation.prepareFailed"));
        }
      } finally {
        barrier.release();
        if (scope.isCurrent()) {
          preparingRef.current = false;
          setPreparing(false);
        }
      }
    },
    [doc, assistantId, navigate, returnTo, isMobile, t],
  );
  const handleSubmitFeedback = useCallback(
    () => prepareConversation(true),
    [prepareConversation],
  );
  const handleStartConversation = useCallback(
    () => prepareConversation(false),
    [prepareConversation],
  );

  if (state.kind === "loading") {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2
          size={24}
          className="animate-spin text-[var(--content-tertiary)]"
        />
      </div>
    );
  }
  if (state.kind === "error" || !doc || !assistantId) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3">
        <Typography
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {t("documentViewerPage.notFound")}
        </Typography>
        <Button onClick={() => setAttempt((value) => value + 1)}>
          {t("documentConversation.retry")}
        </Button>
        <Button variant="ghost" onClick={handleClose}>
          {t("documentConversation.back")}
        </Button>
      </div>
    );
  }
  return (
    <div ref={swipeContainerRef} className="flex min-h-0 flex-1 flex-col">
      {state.needsConversation && (
        <div
          role="status"
          className="flex shrink-0 flex-col gap-2 border-b border-[var(--border-default)] p-3"
        >
          <Typography variant="body-small-default">
            {t("documentConversation.missing")}
          </Typography>
          <Button disabled={preparing} onClick={handleStartConversation}>
            {t("documentConversation.start")}
          </Button>
        </div>
      )}
      <DocumentViewerContainer
        key={assistantId + ":" + doc.surfaceId}
        source="document"
        surfaceId={doc.surfaceId}
        assistantId={assistantId}
        conversationId={doc.conversationId}
        documentName={doc.title}
        content={doc.content}
        onClose={handleClose}
        onRenamed={(title) =>
          setState((previous) =>
            previous.kind === "ready"
              ? { ...previous, doc: { ...previous.doc, title } }
              : previous,
          )
        }
        onExport={handleExport}
        onSubmitFeedback={handleSubmitFeedback}
        handleRef={viewerRef}
      />
    </div>
  );
}
