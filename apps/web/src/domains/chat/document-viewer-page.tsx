/**
 * Route component for viewing a single document with comment integration.
 *
 * Fetches the document by surfaceId from the URL params and renders the
 * `DocumentViewerContainer` with comment panel support. Subscribes to the
 * assistant SSE stream and forwards document comment events to the viewer
 * for real-time panel updates.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { Loader2 } from "lucide-react";
import { Typography } from "@vellum/design-library";

import {
  type DocumentContent,
  exportDocumentPDF,
  fetchDocumentContent,
} from "./api/documents.js";
import { useDocumentCommentEvents } from "./hooks/use-document-comment-events.js";
import { subscribeChatEvents } from "./api/stream.js";
import {
  DocumentViewerContainer,
  type DocumentViewerContainerHandle,
} from "./components/document-viewer-container.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default assistant ID — matches the platform single-assistant model. */
const DEFAULT_ASSISTANT_ID = "default";

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function DocumentViewerPage() {
  const { surfaceId } = useParams<{ surfaceId: string }>();
  const navigate = useNavigate();

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

    let cancelled = false;
    void (async () => {
      try {
        const result = await fetchDocumentContent(
          DEFAULT_ASSISTANT_ID,
          surfaceId,
        );
        if (cancelled) return;
        if (!result) {
          setError("Document not found.");
        } else {
          setDoc(result);
        }
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
  }, [surfaceId]);

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

  useEffect(() => {
    if (!surfaceId) return;

    const stream = subscribeChatEvents(
      DEFAULT_ASSISTANT_ID,
      null,
      handleSseEvent,
      () => {
        // SSE error — the stream handler manages reconnects; we only need
        // to handle events when they arrive.
      },
    );

    return () => {
      stream.cancel();
    };
  }, [surfaceId, handleSseEvent]);

  // -------------------------------------------------------------------------
  // Navigation & export
  // -------------------------------------------------------------------------

  const handleClose = useCallback(() => {
    navigate(-1);
  }, [navigate]);

  const handleExport = useCallback(async () => {
    if (!doc) return;
    const blob = await exportDocumentPDF(DEFAULT_ASSISTANT_ID, doc.surfaceId);
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement("a"), {
      href: url,
      download: `${doc.title || "document"}.pdf`,
    });
    a.click();
    URL.revokeObjectURL(url);
  }, [doc]);

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

  if (error || !doc) {
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
    <DocumentViewerContainer
      surfaceId={doc.surfaceId}
      assistantId={DEFAULT_ASSISTANT_ID}
      conversationId={doc.conversationId}
      documentName={doc.title}
      content={doc.content}
      onClose={handleClose}
      onExport={handleExport}
      handleRef={viewerRef}
    />
  );
}
