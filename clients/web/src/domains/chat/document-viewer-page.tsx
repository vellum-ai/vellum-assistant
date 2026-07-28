/**
 * Route component for viewing a single document with comment integration.
 *
 * Fetches the document by surfaceId from the URL params and renders the
 * `DocumentViewerContainer` with comment panel support. Subscribes to the
 * assistant SSE stream and forwards document comment events to the viewer
 * for real-time panel updates.
 */

import { Typography } from "@vellumai/design-library";
import { Loader2 } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";

import { useEdgeSwipeBack } from "@/hooks/use-edge-swipe-back";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import {
    documentsByIdConversationsPost,
    documentsByIdGet,
    documentsByIdPdfGet,
} from "@/generated/daemon/sdk.gen";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useViewerStore } from "@/stores/viewer-store";
import type { DocumentContent } from "@/types/document-types";
import { getEditChatConversationId, setEditChatConversationId } from "@/utils/edit-chat-session";
import { routes } from "@/utils/routes";
import {
    DocumentViewerContainer,
    type DocumentViewerContainerHandle,
} from "./components/document-viewer-container";
import { useDocumentCommentEvents } from "./hooks/use-document-comment-events";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentViewerPage() {
  const { surfaceId } = useParams<{ surfaceId: string }>();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const isMobile = useIsMobile();
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const swipeContainerRef = useRef<HTMLDivElement>(null);

  const [doc, setDoc] = useState<DocumentContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const viewerRef = useRef<DocumentViewerContainerHandle>(null);

  useEffect(() => {
    if (!surfaceId) {
      setError("No document ID provided.");
      setLoading(false);
      return;
    }
    // Wait for the selection store to resolve before fetching — on cold nav
    // assistantId starts null and the lifecycle hook fills it asynchronously.
    if (!assistantId) {return;}

    let cancelled = false;
    void (async () => {
      try {
        const { data: result } = await documentsByIdGet({
          path: { assistant_id: assistantId, id: surfaceId },
          throwOnError: true,
        });
        if (cancelled) {return;}
        setDoc(result);
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
    if (!doc || !assistantId || !surfaceId) {return;}

    // Prefer the document's original conversation — the document is already
    // linked there, so the injector will surface the comments automatically.
    // Fall back to session-cached conversation id for repeated feedback.
    const conversationId =
      doc.conversationId
      || getEditChatConversationId(assistantId, surfaceId)
      || (typeof globalThis.crypto?.randomUUID === "function"
        ? globalThis.crypto.randomUUID()
        : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`);

    setEditChatConversationId(assistantId, surfaceId, conversationId);

    if (conversationId !== doc.conversationId) {
      try {
        await documentsByIdConversationsPost({
          path: { assistant_id: assistantId, id: surfaceId },
          body: { conversationId },
          throwOnError: true,
        });
      } catch {
        // Best-effort — fails if the daemon doesn't have the route yet.
      }
    }

    useViewerStore.getState().openDocument();
    useViewerStore.getState().setLoadedDocument({
      surfaceId: doc.surfaceId,
      conversationId,
      documentName: doc.title,
      content: doc.content,
    });

    const prompt = `Please review and address my comments on "${doc.title}".`;
    navigate(`${routes.conversation(conversationId)}?prompt=${encodeURIComponent(prompt)}`);
  }, [doc, assistantId, surfaceId, navigate]);

  const handleExport = useCallback(async () => {
    if (!doc || !assistantId) {return;}
    const { data: blob, response: pdfResponse } = await documentsByIdPdfGet({
      path: { assistant_id: assistantId, id: doc.surfaceId },
      throwOnError: false,
      parseAs: "blob",
    });
    if (!pdfResponse?.ok || !blob) {return;}
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `${doc.title || "document"}.pdf`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }, [doc, assistantId]);

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center">
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
          {error ?? "Document not found."}
        </Typography>
      </div>
    );
  }

  return (
    <div ref={swipeContainerRef} className="flex min-h-0 flex-1 flex-col">
      <DocumentViewerContainer
        surfaceId={doc.surfaceId}
        assistantId={assistantId}
        conversationId={doc.conversationId}
        documentName={doc.title}
        content={doc.content}
        onClose={handleClose}
        onExport={handleExport}
        onSubmitFeedback={handleSubmitFeedback}
        handleRef={viewerRef}
      />
    </div>
  );
}
