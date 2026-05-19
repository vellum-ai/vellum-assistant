/**
 * App and document viewer action handlers.
 *
 * Consolidates the app/document lifecycle operations previously inlined in
 * `AssistantPageClient`: open, close, share, deploy, edit, navigate
 * (back/forward), and deep-link auto-open. All framework-specific routing
 * is delegated to adapter callbacks (`pushConversationKeyParam`) so the hook
 * stays portable for the Vite + React Router v7 migration.
 *
 * @see viewer-state.ts — the reducer that owns viewer UI state
 */

import * as Sentry from "@sentry/react";
import { type Dispatch, type MutableRefObject, type RefObject, useCallback, useEffect, useRef } from "react";

import { toast } from "@vellum/design-library";
import { openApp, shareApp } from "@/domains/chat/lib/apps.js";
import { fetchDocumentContent } from "@/domains/chat/lib/documents.js";
import { getEditChatKey, setEditChatKey } from "@/domains/chat/lib/edit-chat-session.js";
import type { ViewSelection } from "@/domains/chat/lib/navigation-history.js";
import { getVercelConfig, isCredentialError, publishApp } from "@/domains/chat/lib/publish.js";
import type {
  MainView,
  OpenedAppState,
  ViewerAction,
  ViewerState,
} from "@/domains/chat/lib/viewer-state.js";
import type { Conversation } from "@/domains/chat/lib/api.js";
import type { ConversationListAction } from "@/domains/chat/lib/conversation-list-state.js";
import { haptic } from "@/utils/haptics.js";

import { useActiveAppPinSync } from "@/domains/chat/hooks/use-active-app-pin-sync.js";

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
  dispatchViewer: Dispatch<ViewerAction>;
  dispatchConversationList: Dispatch<ConversationListAction>;
  viewerStateRef: MutableRefObject<ViewerState>;
  lastConversationKeyRef: MutableRefObject<string | null>;
  deepLinkAppId: RefObject<string | undefined>;
  switchConversation: (key: string) => void;
  setMainView: (view: MainView) => void;
  navPush: (selection: ViewSelection) => void;
  navGoBack: () => ViewSelection | null;
  navGoForward: () => ViewSelection | null;
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
 * - Navigation back/forward via `applyViewSelection`
 * - Open/close/minimize/edit handlers for the app and document viewers
 * - Share-to-file and deploy-to-Vercel flows (including the token dialog)
 * - Deep-link auto-open on mount
 * - Pin-sync side-effect (navigates away when the active app is unpinned)
 *
 * All handlers dispatch to `viewerReducer` / `conversationListReducer` and
 * call domain API functions — no direct framework imports.
 */
export function useAppViewerActions({
  assistantId,
  activeConversationKey,
  conversations,
  openedAppState,
  isSharing,
  isDeploying,
  pendingDeployAppId,
  dispatchViewer,
  dispatchConversationList,
  viewerStateRef,
  lastConversationKeyRef,
  deepLinkAppId,
  switchConversation,
  setMainView,
  navPush,
  navGoBack,
  navGoForward,
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
      dispatchViewer({ type: "OPEN_APP_START", appId });
      try {
        const result = await openApp(assistantId, appId);
        if (openAppRequestRef.current !== appId) return;
        dispatchViewer({ type: "APP_LOADED", app: { appId: result.appId, dirName: result.dirName, name: result.name, html: result.html } });
      } catch (err) {
        if (openAppRequestRef.current !== appId) return;
        Sentry.captureException(err, { tags: { context: "openApp" } });
        dispatchViewer({ type: "APP_LOAD_FAILED" });
      }
    },
    [assistantId, dispatchViewer],
  );

  const loadDocument = useCallback(
    async (documentSurfaceId: string) => {
      if (!assistantId) return;
      openDocumentRequestRef.current = documentSurfaceId;
      dispatchViewer({ type: "OPEN_DOCUMENT_START" });
      try {
        const result = await fetchDocumentContent(assistantId, documentSurfaceId);
        if (openDocumentRequestRef.current !== documentSurfaceId) return;
        if (!result) {
          dispatchViewer({ type: "DOCUMENT_LOAD_FAILED" });
          return;
        }
        dispatchViewer({
          type: "DOCUMENT_LOADED",
          document: {
            surfaceId: result.surfaceId,
            conversationId: result.conversationId,
            documentName: result.title ?? "Untitled",
            content: result.content ?? "",
          },
        });
      } catch {
        if (openDocumentRequestRef.current !== documentSurfaceId) return;
        dispatchViewer({ type: "DOCUMENT_LOAD_FAILED" });
      }
    },
    [assistantId, dispatchViewer],
  );

  // ---------------------------------------------------------------------------
  // Navigation (back/forward history)
  // ---------------------------------------------------------------------------

  /** Apply a navigation history ViewSelection without recording a new push. */
  const applyViewSelection = useCallback(
    (selection: ViewSelection) => {
      switch (selection.type) {
        case "conversation":
          switchConversationRef.current(selection.key);
          break;
        case "home":
          setMainView("home");
          break;
        case "intelligence":
          setMainView("intelligence");
          break;
        case "library":
          setMainView("library");
          break;
        case "app":
          void loadApp(selection.appId);
          break;
        case "document":
          void loadDocument(selection.surfaceId);
          break;
      }
    },
    [setMainView, loadApp, loadDocument],
  );

  const handleGoBack = useCallback(() => {
    const dest = navGoBack();
    if (dest) applyViewSelection(dest);
  }, [navGoBack, applyViewSelection]);

  const handleGoForward = useCallback(() => {
    const dest = navGoForward();
    if (dest) applyViewSelection(dest);
  }, [navGoForward, applyViewSelection]);

  // ---------------------------------------------------------------------------
  // Open / close handlers
  // ---------------------------------------------------------------------------

  const handleOpenApp = useCallback(
    async (appId: string) => {
      haptic.light();
      navPush({ type: "app", appId });
      await loadApp(appId);
    },
    [navPush, loadApp],
  );

  const handleOpenDocument = useCallback(
    (documentSurfaceId: string) => {
      haptic.light();
      void loadDocument(documentSurfaceId);
    },
    [loadDocument],
  );

  const handleCloseDocument = useCallback(() => {
    const prev = viewerStateRef.current.viewBeforeDocument;
    dispatchViewer({ type: "CLOSE_DOCUMENT" });
    if (prev !== "library" && prev !== "intelligence") {
      if (lastConversationKeyRef.current) {
        switchConversationRef.current(lastConversationKeyRef.current);
      }
    }
  }, [dispatchViewer, viewerStateRef, lastConversationKeyRef]);

  const handleCloseApp = useCallback(() => {
    dispatchViewer({ type: "CLOSE_APP" });
    dispatchConversationList({ type: "SET_EDITING_KEY", key: null });
    if (lastConversationKeyRef.current) {
      switchConversationRef.current(lastConversationKeyRef.current);
    } else {
      dispatchViewer({ type: "SET_MAIN_VIEW", view: "chat" });
    }
  }, [dispatchViewer, dispatchConversationList, lastConversationKeyRef]);

  const handleToggleAppMinimized = useCallback(() => {
    dispatchViewer({ type: "TOGGLE_APP_MINIMIZED" });
  }, [dispatchViewer]);

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

      dispatchConversationList({ type: "SET_EDITING_KEY", key: conversationKey });
      dispatchViewer({ type: "ENTER_APP_EDITING" });
      if (activeConversationKey !== conversationKey) {
        pushConversationKeyParamRef.current(conversationKey);
      }
    },
    [
      assistantId,
      conversations,
      activeConversationKey,
      dispatchConversationList,
      dispatchViewer,
    ],
  );

  const handleEditApp = useCallback(() => {
    if (!openedAppState) return;
    enterEditingForLoadedApp(openedAppState.appId);
  }, [openedAppState, enterEditingForLoadedApp]);

  // Used when an app is opened outside the chat viewer (e.g. from the library
  // grid, which keeps its own local viewer state). Hydrates the viewer reducer
  // with the already-loaded app so the edit transition has a canonical
  // `openedAppState` to land on, then enters editing mode.
  const handleEditAppFromDetached = useCallback(
    (app: { appId: string; dirName?: string; name: string; html: string }) => {
      dispatchViewer({ type: "OPEN_APP_START", appId: app.appId });
      dispatchViewer({ type: "APP_LOADED", app });
      enterEditingForLoadedApp(app.appId);
    },
    [dispatchViewer, enterEditingForLoadedApp],
  );

  const handleCloseEditPanel = useCallback(() => {
    dispatchConversationList({ type: "SET_EDITING_KEY", key: null });
    dispatchViewer({ type: "EXIT_APP_EDITING" });
  }, [dispatchConversationList, dispatchViewer]);

  // ---------------------------------------------------------------------------
  // Share / Deploy
  // ---------------------------------------------------------------------------

  const handleShareApp = useCallback(async () => {
    if (!openedAppState || !assistantId || isSharing) return;
    dispatchViewer({ type: "START_SHARING" });
    try {
      await shareApp(assistantId, openedAppState.appId, openedAppState.name);
      toast.success("App exported", { description: `${openedAppState.name}.vellum` });
    } catch (err) {
      toast.error("Failed to share app", {
        description: err instanceof Error ? err.message : undefined,
      });
    } finally {
      dispatchViewer({ type: "SHARING_DONE" });
    }
  }, [openedAppState, assistantId, isSharing, dispatchViewer]);

  const handleDeployApp = useCallback(async () => {
    if (!openedAppState || !assistantId || isDeploying) return;
    if (openedAppState.html.includes("vellum.fetch") || openedAppState.html.includes("vellum.sendAction") || openedAppState.html.includes("/v1/x/") || openedAppState.html.includes("/v1/apps/") ) {
      dispatchViewer({ type: "SET_COMPLEX_DEPLOY_APP", app: { appId: openedAppState.appId, name: openedAppState.name } });
      return;
    }
    dispatchViewer({ type: "START_DEPLOYING" });
    try {
      const config = await getVercelConfig(assistantId);
      if (!config.hasToken) {
        dispatchViewer({ type: "SHOW_TOKEN_DIALOG", pendingAppId: openedAppState.appId });
        return;
      }
      const result = await publishApp(assistantId, openedAppState.appId);
      if (!result.success) {
        if (isCredentialError(result)) {
          dispatchViewer({ type: "SHOW_TOKEN_DIALOG", pendingAppId: openedAppState.appId });
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
      dispatchViewer({ type: "DEPLOYING_DONE" });
    }
  }, [openedAppState, assistantId, isDeploying, dispatchViewer]);

  const handleDeployTokenSaved = useCallback(() => {
    dispatchViewer({ type: "HIDE_TOKEN_DIALOG" });
    if (pendingDeployAppId && assistantId) {
      dispatchViewer({ type: "START_DEPLOYING" });
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
          dispatchViewer({ type: "DEPLOYING_DONE", clearPendingAppId: true });
        });
    }
  }, [pendingDeployAppId, assistantId, dispatchViewer]);

  // ---------------------------------------------------------------------------
  // Pin-sync side-effect
  // ---------------------------------------------------------------------------

  const handleActiveAppUnpinned = useCallback(
    (appId: string) => {
      dispatchViewer({ type: "ACTIVE_APP_UNPINNED", appId });
      if (
        viewerStateRef.current.activeAppId === appId &&
        (viewerStateRef.current.mainView === "app" || viewerStateRef.current.mainView === "app-editing")
      ) {
        dispatchConversationList({ type: "SET_EDITING_KEY", key: null });
      }
    },
    [dispatchViewer, dispatchConversationList, viewerStateRef],
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
    handleGoBack,
    handleGoForward,
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
