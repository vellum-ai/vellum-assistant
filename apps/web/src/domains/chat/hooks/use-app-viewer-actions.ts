/**
 * App and document viewer action handlers.
 *
 * Consolidates the app/document lifecycle operations previously inlined in
 * `AssistantPageClient`: open, close, share, deploy, edit, navigate
 * (back/forward), and deep-link auto-open. All framework-specific routing
 * is delegated to adapter callbacks (`pushConversationKeyParam`) so the hook
 * stays portable for the Vite + React Router v7 migration.
 *
 * @see stores/viewer-store.ts — Zustand store for viewer UI state
 */

import * as Sentry from "@sentry/react";
import { type MutableRefObject, type RefObject, useCallback, useEffect, useRef } from "react";

import { toast } from "@vellum/design-library";
import { openApp, shareApp } from "@/domains/chat/api/apps.js";
import { fetchDocumentContent } from "@/domains/chat/api/documents.js";
import { getEditChatKey, setEditChatKey } from "@/domains/chat/utils/edit-chat-session.js";
import { getVercelConfig, isCredentialError, publishApp } from "@/domains/chat/api/publish.js";
import type {
  OpenedAppState,
} from "@/stores/viewer-store.js";
import { useViewerStore } from "@/stores/viewer-store.js";
import { useConversationListStore } from "@/domains/conversations/conversation-list-store.js";
import { haptic } from "@/utils/haptics.js";

import { useActiveAppPinSync } from "@/domains/chat/hooks/use-active-app-pin-sync.js";
import type { Conversation } from "@/domains/chat/api/conversations.js";

// ---------------------------------------------------------------------------
// Params
// ---------------------------------------------------------------------------

export interface UseAppViewerActionsParams {
  assistantId: string | null;
  activeConversationKey: string | null;
  conversations: Conversation[];
  openedAppState: OpenedAppState | null;
  isSharing: boolean;
  isDeploying: boolean;
  pendingDeployAppId: string | null;
  lastConversationKeyRef: MutableRefObject<string | null>;
  deepLinkAppId: RefObject<string | undefined>;
  switchConversation: (key: string) => void;
  /**
   * Framework adapter: set the `conversationKey` URL search parameter.
   *
   * In Next.js this is wired to `router.push(`?${params.toString()}`)`; in
   * React Router v7 it will map to `setSearchParams`.
   */
  pushConversationKeyParam: (key: string) => void;
}

// ---------------------------------------------------------------------------
// Hook
// ---------------------------------------------------------------------------

/**
 * App and document viewer actions extracted from `AssistantPageClient`.
 *
 * Owns:
 * - Core loaders (`loadApp`, `loadDocument`) with concurrent-request guards
 * - Open/close/minimize/edit handlers for the app and document viewers
 * - Share-to-file and deploy-to-Vercel flows (including the token dialog)
 * - Deep-link auto-open on mount
 * - Pin-sync side-effect (navigates away when the active app is unpinned)
 *
 * Viewer state is managed via the Zustand `useViewerStore`.
 */
export function useAppViewerActions({
  assistantId,
  activeConversationKey,
  conversations,
  openedAppState,
  isSharing,
  isDeploying,
  pendingDeployAppId,
  lastConversationKeyRef,
  deepLinkAppId,
  switchConversation,
  pushConversationKeyParam,
}: UseAppViewerActionsParams) {
  // Ref-stabilize unstable callbacks so consuming useCallbacks keep stable identity.
  const switchConversationRef = useRef(switchConversation);
  switchConversationRef.current = switchConversation;

  const pushConversationKeyParamRef = useRef(pushConversationKeyParam);
  pushConversationKeyParamRef.current = pushConversationKeyParam;

  // Tracks the appId / documentSurfaceId of the most recent open request so
  // concurrent calls don't let a late-arriving response overwrite the latest.
  const openAppRequestRef = useRef<string | null>(null);
  const openDocumentRequestRef = useRef<string | null>(null);

  // ---------------------------------------------------------------------------
  // Core loaders (no nav history recording)
  // ---------------------------------------------------------------------------

  /** Fetch and display an app without recording nav history. */
  const loadApp = useCallback(
    async (appId: string) => {
      if (!assistantId) return;
      openAppRequestRef.current = appId;
      useViewerStore.getState().openApp(appId);
      try {
        const result = await openApp(assistantId, appId);
        if (openAppRequestRef.current !== appId) return;
        useViewerStore.getState().setLoadedApp({ appId: result.appId, dirName: result.dirName, name: result.name, html: result.html });
      } catch (err) {
        if (openAppRequestRef.current !== appId) return;
        Sentry.captureException(err, { tags: { context: "openApp" } });
        useViewerStore.getState().handleAppLoadFailed();
      }
    },
    [assistantId],
  );

  const loadDocument = useCallback(
    async (documentSurfaceId: string) => {
      if (!assistantId) return;
      openDocumentRequestRef.current = documentSurfaceId;
      useViewerStore.getState().openDocument();
      try {
        const result = await fetchDocumentContent(assistantId, documentSurfaceId);
        if (openDocumentRequestRef.current !== documentSurfaceId) return;
        if (!result) {
          useViewerStore.getState().handleDocumentLoadFailed();
          return;
        }
        useViewerStore.getState().setLoadedDocument({
          surfaceId: result.surfaceId,
          conversationId: result.conversationId,
          documentName: result.title ?? "Untitled",
          content: result.content ?? "",
        });
      } catch {
        if (openDocumentRequestRef.current !== documentSurfaceId) return;
        useViewerStore.getState().handleDocumentLoadFailed();
      }
    },
    [assistantId],
  );

  // ---------------------------------------------------------------------------
  // Open / close handlers
  // ---------------------------------------------------------------------------

  const handleOpenApp = useCallback(
    async (appId: string) => {
      haptic.light();
      await loadApp(appId);
    },
    [loadApp],
  );

  const handleOpenDocument = useCallback(
    (documentSurfaceId: string) => {
      haptic.light();
      void loadDocument(documentSurfaceId);
    },
    [loadDocument],
  );

  const handleCloseDocument = useCallback(() => {
    useViewerStore.getState().closeDocument();
    if (lastConversationKeyRef.current) {
      switchConversationRef.current(lastConversationKeyRef.current);
    }
  }, [lastConversationKeyRef]);

  const handleCloseApp = useCallback(() => {
    useViewerStore.getState().closeApp();
    useConversationListStore.getState().setEditingKey(null);
    useViewerStore.getState().setMainView("chat");
    if (lastConversationKeyRef.current) {
      switchConversationRef.current(lastConversationKeyRef.current);
    }
  }, [lastConversationKeyRef]);

  const handleToggleAppMinimized = useCallback(() => {
    useViewerStore.getState().toggleAppMinimized();
  }, []);

  // ---------------------------------------------------------------------------
  // Edit mode
  // ---------------------------------------------------------------------------

  // Resolves the conversation key to use for editing this app.
  //
  // Each (assistantId, appId) keeps its own per-tab edit-chat memory (4h TTL,
  // see `edit-chat-session.ts`). On a hit we drop the user back into the same
  // chat so iterative edits stay threaded. On a miss — first edit in the
  // session, expired entry, or the prior conversation has been deleted — we
  // mint a fresh draft and remember it for the next edit click.
  const enterEditingForLoadedApp = useCallback(
    (appId: string) => {
      const stored = assistantId ? getEditChatKey(assistantId, appId) : null;
      const storedStillExists =
        stored !== null &&
        (conversations.length === 0 ||
          conversations.some((c) => c.conversationKey === stored));
      const conversationKey = storedStillExists
        ? stored
        : typeof globalThis.crypto?.randomUUID === "function"
          ? globalThis.crypto.randomUUID()
          : `draft-${Date.now()}-${Math.random().toString(16).slice(2)}`;

      if (assistantId) {
        setEditChatKey(assistantId, appId, conversationKey);
      }

      useConversationListStore.getState().setEditingKey(conversationKey);
      useViewerStore.getState().enterAppEditing();
      if (activeConversationKey !== conversationKey) {
        pushConversationKeyParamRef.current(conversationKey);
      }
    },
    [
      assistantId,
      conversations,
      activeConversationKey,
    ],
  );

  const handleEditApp = useCallback(() => {
    if (!openedAppState) return;
    enterEditingForLoadedApp(openedAppState.appId);
  }, [openedAppState, enterEditingForLoadedApp]);

  // Used when an app is opened outside the chat viewer (e.g. from the library
  // grid, which keeps its own local viewer state). Hydrates the viewer store
  // with the already-loaded app so the edit transition has a canonical
  // `openedAppState` to land on, then enters editing mode.
  const handleEditAppFromDetached = useCallback(
    (app: { appId: string; dirName?: string; name: string; html: string }) => {
      const store = useViewerStore.getState();
      store.openApp(app.appId);
      store.setLoadedApp(app);
      enterEditingForLoadedApp(app.appId);
    },
    [enterEditingForLoadedApp],
  );

  const handleCloseEditPanel = useCallback(() => {
    useConversationListStore.getState().setEditingKey(null);
    useViewerStore.getState().exitAppEditing();
  }, []);

  // ---------------------------------------------------------------------------
  // Share / Deploy
  // ---------------------------------------------------------------------------

  const handleShareApp = useCallback(async () => {
    if (!openedAppState || !assistantId || isSharing) return;
    useViewerStore.getState().startSharing();
    try {
      await shareApp(assistantId, openedAppState.appId, openedAppState.name);
      toast.success("App exported", { description: `${openedAppState.name}.vellum` });
    } catch (err) {
      toast.error("Failed to share app", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      useViewerStore.getState().finishSharing();
    }
  }, [openedAppState, assistantId, isSharing]);

  const handleDeployApp = useCallback(async () => {
    if (!openedAppState || !assistantId || isDeploying) return;
    if (openedAppState.html.includes("vellum.fetch") || openedAppState.html.includes("vellum.sendAction") || openedAppState.html.includes("/v1/x/") || openedAppState.html.includes("/v1/apps/") ) {
      useViewerStore.getState().setComplexDeployApp({ appId: openedAppState.appId, name: openedAppState.name });
      return;
    }
    useViewerStore.getState().startDeploying();
    try {
      const config = await getVercelConfig(assistantId);
      if (!config.hasToken) {
        useViewerStore.getState().showTokenDialog(openedAppState.appId);
        return;
      }
      const result = await publishApp(assistantId, openedAppState.appId);
      if (!result.success) {
        if (isCredentialError(result)) {
          useViewerStore.getState().showTokenDialog(openedAppState.appId);
        } else {
          toast.error("Failed to deploy", { description: result.error });
        }
      } else if (result.publicUrl) {
        toast.success("Deployed to Vercel", {
          description: result.publicUrl,
          action: {
            label: "Open",
            onClick: () => window.open(result.publicUrl, "_blank"),
          },
        });
      } else {
        toast.success("Deployed to Vercel");
      }
    } catch (err) {
      toast.error("Failed to deploy", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      useViewerStore.getState().finishDeploying();
    }
  }, [openedAppState, assistantId, isDeploying]);

  const handleDeployTokenSaved = useCallback(() => {
    useViewerStore.getState().hideTokenDialog();
    if (pendingDeployAppId && assistantId) {
      useViewerStore.getState().startDeploying();
      void publishApp(assistantId, pendingDeployAppId)
        .then((result) => {
          if (!result.success) {
            toast.error("Failed to deploy", { description: result.error });
          } else if (result.publicUrl) {
            toast.success("Deployed to Vercel", {
              description: result.publicUrl,
              action: {
                label: "Open",
                onClick: () => window.open(result.publicUrl, "_blank"),
              },
            });
          } else {
            toast.success("Deployed to Vercel");
          }
        })
        .catch((err) => {
          toast.error("Failed to deploy", {
            description: err instanceof Error ? err.message : undefined,
          });
        })
        .finally(() => {
          useViewerStore.getState().finishDeploying(true);
        });
    }
  }, [pendingDeployAppId, assistantId]);

  // ---------------------------------------------------------------------------
  // Pin-sync side-effect
  // ---------------------------------------------------------------------------

  const handleActiveAppUnpinned = useCallback(
    (appId: string) => {
      const { activeAppId, mainView } = useViewerStore.getState();
      useViewerStore.getState().handleAppUnpinned(appId);
      if (
        activeAppId === appId &&
        (mainView === "app" || mainView === "app-editing")
      ) {
        useConversationListStore.getState().setEditingKey(null);
      }
    },
    [],
  );

  useActiveAppPinSync(handleActiveAppUnpinned);

  // ---------------------------------------------------------------------------
  // Deep-link auto-open
  // ---------------------------------------------------------------------------

  const didDeepLinkOpen = useRef(false);
  useEffect(() => {
    if (didDeepLinkOpen.current || !deepLinkAppId.current || !assistantId) return;
    didDeepLinkOpen.current = true;
    void handleOpenApp(deepLinkAppId.current);
  }, [assistantId, handleOpenApp, deepLinkAppId]);

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  return {
    loadApp,
    loadDocument,
    handleOpenApp,
    handleOpenDocument,
    handleCloseDocument,
    handleCloseApp,
    handleToggleAppMinimized,
    handleEditApp,
    handleEditAppFromDetached,
    handleCloseEditPanel,
    handleShareApp,
    handleDeployApp,
    handleDeployTokenSaved,
  };
}
