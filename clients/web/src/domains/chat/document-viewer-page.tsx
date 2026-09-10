import { useTranslation } from "@/i18n";
/**
 * Route component for viewing a single document with comment integration.
 *
 * Fetches the document by surfaceId from the URL params and renders the
 * `DocumentViewerContainer` with comment panel support. Subscribes to the
 * assistant SSE stream and forwards document comment events to the viewer
 * for real-time panel updates.
 */

import { Typography } from "@vellumai/design-library";
import { toast } from "@vellumai/design-library/components/toast";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { useEdgeSwipeBack } from "@/hooks/use-edge-swipe-back";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
  conversationsPost,
  documentsByIdGet,
} from "@/generated/daemon/sdk.gen";
import { downloadDocumentPdf } from "@/domains/chat/api/surfaces";
import { DocumentComposerPanel } from "@/domains/chat/components/document-composer-panel";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import {
  linkDocumentConversationIfNeeded,
  persistDocumentConversationId,
  resolveDocumentConversationId,
} from "@/domains/chat/utils/document-conversation";
import { MIN_VERSION as SERVER_MINT_MIN_VERSION } from "@/lib/backwards-compat/server-minted-conversation";
import {
  assistantScopedSupports,
  whenAssistantVersionKnownFor,
} from "@/lib/backwards-compat/utils";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { resolveEditChatDraftConversationId } from "@/utils/edit-chat-session";
import type { DocumentContent } from "@/types/document-types";
import { routes } from "@/utils/routes";
import {
  DocumentViewerContainer,
  type DocumentViewerContainerHandle,
} from "./components/document-viewer-container";
import { useDocumentCommentEvents } from "./hooks/use-document-comment-events";
import { useUnseenDocumentChangesStore } from "./unseen-document-changes-store";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentViewerPage() {
  const { t } = useTranslation("chat");
  const { surfaceId } = useParams<{ surfaceId: string }>();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const swipeContainerRef = useRef<HTMLDivElement>(null);

  const [doc, setDoc] = useState<DocumentContent | null>(null);
  const [docAssistantId, setDocAssistantId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const viewerRef = useRef<DocumentViewerContainerHandle>(null);
  // Submit Feedback mints and links a row before it navigates, and a second
  // tap during that work would mint a second row and race the first for the
  // link and the navigation, so the action runs one at a time per document:
  // the ref names the surface whose action is out. This page instance is
  // reused across route parameter changes, so the route's current surface is
  // mirrored into a ref for the in-flight action to check against.
  const feedbackInFlightRef = useRef<string | null>(null);
  const routeSurfaceIdRef = useRef<string | undefined>(surfaceId);
  useEffect(() => {
    routeSurfaceIdRef.current = surfaceId;
    // Leaving the document route is leaving every document, so an action
    // still out reads its surface as gone and writes nothing.
    return () => {
      routeSurfaceIdRef.current = undefined;
    };
  }, [surfaceId]);

  useEffect(() => {
    if (!surfaceId) {
      setError("No document ID provided.");
      setLoading(false);
      return;
    }
    // Wait for the selection store to resolve before fetching — on cold nav
    // assistantId starts null and the lifecycle hook fills it asynchronously.
    if (!assistantId) {
      return;
    }

    setLoading(true);
    setError(null);

    let cancelled = false;
    void (async () => {
      try {
        const { data: result } = await documentsByIdGet({
          path: { assistant_id: assistantId, id: surfaceId },
          throwOnError: true,
        });
        if (cancelled) {
          return;
        }
        setDoc(result);
        setDocAssistantId(assistantId);
        // This route is a second way into a document, separate from the
        // in-chat viewer, so it clears the unseen record itself.
        useUnseenDocumentChangesStore
          .getState()
          .clearDocumentEverywhere(surfaceId);
      } catch {
        if (!cancelled) {
          setError("Failed to load document.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [surfaceId, assistantId]);

  // -------------------------------------------------------------------------
  // SSE subscription for real-time comment events
  // -------------------------------------------------------------------------

  const handleCommentsChanged = useCallback(() => {
    void viewerRef.current?.refreshComments();
  }, []);

  const handleSseEvent = useDocumentCommentEvents({
    surfaceId: surfaceId ?? "",
    enabled: !!surfaceId,
    onCommentsChanged: handleCommentsChanged,
  });

  useBusSubscription("sse.event", handleSseEvent);

  // -------------------------------------------------------------------------
  // Navigation & export
  // -------------------------------------------------------------------------

  const handleClose = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  useEdgeSwipeBack({
    containerRef: swipeContainerRef,
    onBack: handleClose,
    enabled: isMobile,
    navKey: pathname,
  });

  const handleSubmitFeedback = useCallback(async () => {
    if (
      !doc ||
      !assistantId ||
      !surfaceId ||
      feedbackInFlightRef.current === surfaceId
    ) {
      return;
    }
    feedbackInFlightRef.current = surfaceId;
    try {
      // Every await below is a window the user can switch assistants or move
      // the route to another document inside. The row this mints and links
      // belongs to the assistant and the document the tap was made under, so
      // once either has changed nothing here may write the viewer or
      // navigate: that would point the incoming assistant at the outgoing
      // one's conversation, or pull the newer document's route back to this
      // one's.
      const assistantChanged = () =>
        useResolvedAssistantsStore.getState().activeAssistantId !==
          assistantId || routeSurfaceIdRef.current !== surfaceId;

      // Prefer the document's original conversation: it is already linked
      // there, so the injector will surface the comments automatically. Fall
      // back to session-cached conversation id for repeated feedback.
      //
      // A fresh client draft is an id the daemon has never minted. An
      // assistant that mints rows itself would mint one for the send this
      // navigates into, and start that turn before any relink could land, so
      // the first turn would run without the document. The row is minted and
      // linked here instead, before anything goes out, as the document
      // composer does, and the support check is scoped to this assistant so a
      // switch mid-wait cannot answer for another one.
      //
      // Persisted immediately, ahead of the send this navigates into: unlike
      // `useDocumentComposerSubmit`, this action's own job ends at navigation,
      // with nothing here to observe whether the eventual send that
      // materializes a legacy draft actually succeeds.
      await whenAssistantVersionKnownFor(assistantId);
      if (assistantChanged()) {
        return;
      }
      const resolvedId = resolveDocumentConversationId(doc, assistantId);
      let conversationId = resolvedId;
      const isFreshDraft = useConversationStore
        .getState()
        .draftConversationIds.has(resolvedId);
      const mintsRows = assistantScopedSupports(
        SERVER_MINT_MIN_VERSION,
        assistantId,
      );
      if (isFreshDraft && mintsRows) {
        try {
          const minted = await conversationsPost({
            path: { assistant_id: assistantId },
            body: {},
            throwOnError: true,
          });
          conversationId = minted.data.id;
        } catch {
          toast.error(t("documentComposer.sendFailed"));
          return;
        }
        if (assistantChanged()) {
          return;
        }
        resolveEditChatDraftConversationId(resolvedId, conversationId);
        useConversationStore.getState().clearDraftConversationId(resolvedId);
      }
      persistDocumentConversationId(doc, assistantId, conversationId);
      const linked = await linkDocumentConversationIfNeeded(
        doc,
        assistantId,
        conversationId,
      );
      if (assistantChanged()) {
        return;
      }
      // The turn this navigates into reads the link when it assembles its
      // prompt, so on an assistant that has the link route a refused link
      // would run that turn without the document. An older assistant has no
      // route to refuse and its turn finds the document its own way.
      if (!linked && mintsRows) {
        toast.error(t("documentComposer.sendFailed"));
        return;
      }

      useViewerStore.getState().openDocument();
      useViewerStore.getState().setLoadedDocument({
        source: "document",
        surfaceId: doc.surfaceId,
        conversationId,
        documentName: doc.title,
        content: doc.content,
      });

      const prompt = `Please review and address my comments on "${doc.title}".`;
      navigate(
        `${routes.conversation(conversationId)}?prompt=${encodeURIComponent(prompt)}`,
      );
    } finally {
      if (feedbackInFlightRef.current === surfaceId) {
        feedbackInFlightRef.current = null;
      }
    }
  }, [doc, assistantId, surfaceId, navigate, t]);

  const handleExport = useCallback(async () => {
    if (!doc || !assistantId) {
      return;
    }
    try {
      await downloadDocumentPdf(assistantId, doc.surfaceId, doc.title);
    } catch {
      toast.error(t("documentViewerPage.exportFailed"));
    }
  }, [doc, assistantId, t]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  // The page reuses one instance across changes of the route parameter and of
  // the active assistant, and the loaded document trails both until the next
  // fetch resolves. Every handler the viewer owns (autosave, rename, comments,
  // export, feedback) and the composer below it act on that document under the
  // assistant that is active now, so the page waits for a document matching
  // what the route and the active assistant name.
  const docIsCurrent =
    doc !== null &&
    doc.surfaceId === surfaceId &&
    docAssistantId === assistantId;

  if (loading || (!error && !docIsCurrent)) {
    return (
      <div
        className="flex h-full items-center justify-center"
        data-testid="document-loading"
      >
        <Loader2
          size={24}
          className="animate-spin"
          style={{ color: "var(--content-tertiary)" }}
        />
      </div>
    );
  }

  if (error || !doc || !assistantId) {
    return (
      <div className="flex h-full items-center justify-center">
        <Typography
          variant="body-small-default"
          className="text-[var(--content-tertiary)]"
        >
          {error ?? t("documentViewerPage.notFound")}
        </Typography>
      </div>
    );
  }

  const viewer = (
    <DocumentViewerContainer
      source="document"
      surfaceId={doc.surfaceId}
      assistantId={assistantId}
      conversationId={doc.conversationId}
      documentName={doc.title}
      content={doc.content}
      onClose={handleClose}
      onRenamed={(title) =>
        setDoc((prev) => (prev ? { ...prev, title } : prev))
      }
      onExport={handleExport}
      onSubmitFeedback={handleSubmitFeedback}
      handleRef={viewerRef}
    />
  );

  const composerDoc = {
    surfaceId: doc.surfaceId,
    conversationId: doc.conversationId,
  };

  return (
    <div ref={swipeContainerRef} className="flex min-h-0 flex-1 flex-col">
      {isMobile ? (
        <>
          <div className="min-h-0 flex-1">{viewer}</div>
          <DocumentComposerPanel assistantId={assistantId} doc={composerDoc} />
        </>
      ) : (
        viewer
      )}
    </div>
  );
}
