import {
  type RefObject,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { useConversationStore } from "@/stores/conversation-store";
import { paneState } from "@/stores/pane-state";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { t } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";

import type { DocumentViewerContainerHandle } from "../components/document-viewer-container";
import type { ComposerSendPreparation } from "./use-composer-submit";
import type { DocumentEditorSnapshot } from "./use-document-editor-save";

interface DocumentChatPreparationParams {
  assistantId: string | null;
  conversationId: string | null;
  /** A desktop drawer can show a document linked to a different conversation. */
  documentConversationId?: string | null;
  surfaceId: string | null;
  editorRef: RefObject<DocumentViewerContainerHandle | null>;
}

interface DocumentSendPreparation extends ComposerSendPreparation {
  snapshot: DocumentEditorSnapshot;
}

/** Flushes the visible editor before the ordinary chat send or voice entry. */
export function useDocumentChatPreparation({
  assistantId,
  conversationId,
  documentConversationId = conversationId,
  surfaceId,
  editorRef,
}: DocumentChatPreparationParams) {
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "preparing" }
    | { kind: "error"; message: string }
  >({ kind: "idle" });
  const mountedRef = useRef(true);
  const pendingRef = useRef<symbol | null>(null);
  const ownerRef = useRef({});
  useLayoutEffect(() => {
    mountedRef.current = true;
    ownerRef.current = {};
    pendingRef.current = null;
    setStatus({ kind: "idle" });
    return () => {
      mountedRef.current = false;
    };
  }, [assistantId, conversationId, documentConversationId, surfaceId]);

  const prepareSend =
    useCallback(async (): Promise<DocumentSendPreparation | null> => {
      if (pendingRef.current || !assistantId || !conversationId || !surfaceId) {
        return null;
      }
      const editor = editorRef.current;
      const owner = ownerRef.current;
      const isCurrent = () => {
        const viewer = useViewerStore.getState();
        const conversation = useConversationStore.getState();
        const doc = viewer.openedDocumentState;
        const hasMinimizedApp =
          paneState({
            mainView: viewer.mainView,
            appId: viewer.openedAppState?.appId ?? null,
            conversationId: conversation.activeConversationId,
            boundConversationId: conversation.editingConversationId,
            isAppMinimized: viewer.isAppMinimized,
          }).presentation === "bottom";
        return (
          mountedRef.current &&
          ownerRef.current === owner &&
          editorRef.current === editor &&
          useResolvedAssistantsStore.getState().activeAssistantId ===
            assistantId &&
          conversation.activeConversationId === conversationId &&
          (viewer.mainView === "document" ||
            viewer.mainView === "chat" ||
            hasMinimizedApp) &&
          doc?.source === "document" &&
          doc.assistantId === assistantId &&
          doc.surfaceId === surfaceId &&
          doc.conversationId === documentConversationId
        );
      };
      if (!editor || !isCurrent()) {
        return null;
      }
      const attempt = Symbol();
      pendingRef.current = attempt;
      setStatus({ kind: "preparing" });
      const lease = editor.beginSendPreparation();
      const release = () => {
        lease.release();
        if (pendingRef.current === attempt) {
          pendingRef.current = null;
          if (mountedRef.current && ownerRef.current === owner) {
            setStatus({ kind: "idle" });
          }
        }
      };
      try {
        const snapshot = await lease.flush();
        if (!isCurrent() || !lease.isCurrent()) {
          release();
          return null;
        }
        return {
          snapshot,
          isCurrent: () => isCurrent() && lease.isCurrent(),
          release,
        };
      } catch (error) {
        release();
        captureError(error, { context: "prepare_document_chat" });
        if (isCurrent()) {
          setStatus({
            kind: "error",
            message: t("chat:documentChat.saveFailed"),
          });
        }
        return null;
      }
    }, [
      assistantId,
      conversationId,
      documentConversationId,
      surfaceId,
      editorRef,
    ]);

  const runPrepared = useCallback(
    async (action?: (snapshot: DocumentEditorSnapshot) => void) => {
      const preparation = await prepareSend();
      if (!preparation) {
        return false;
      }
      try {
        if (!preparation.isCurrent()) {
          return false;
        }
        action?.(preparation.snapshot);
        return true;
      } finally {
        preparation.release();
      }
    },
    [prepareSend],
  );

  const prepareVoice = useCallback(() => runPrepared(), [runPrepared]);

  return {
    prepareSend,
    runPrepared,
    prepareVoice,
    preparing: status.kind === "preparing",
    error: status.kind === "error" ? status.message : null,
  };
}
