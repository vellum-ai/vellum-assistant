/**
 * Opening one of a conversation's surfaces in the viewer panel: an app through
 * {@link openAppFromChat}, a document through {@link openDocumentFromChat}.
 * Both buzz and hand off to the viewer store, so every entry point into the
 * viewer from chat feels the same. {@link useOpenAppFromChat} opens an app for
 * the active assistant by navigating to the URL that names it, for the
 * surfaces that do not name an assistant of their own.
 */

import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { toast } from "@vellumai/design-library/components/toast";

import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";
import { prepareFreshConversation } from "@/utils/conversation-navigation";
import {
  documentEntryState,
  documentEntryUrl,
} from "@/utils/document-navigation";
import { appIdForPath, conversationIdForPath, routes } from "@/utils/routes";

import {
  documentRequestScope,
  loadDocumentConversation,
} from "../document-conversation";
import {
  documentReturnPath,
  getDocumentConversationRoute,
  navigateToDocumentConversation,
  setDocumentConversationPresentation,
} from "../document-conversation-navigation";

/** Opens `appId` under `assistantId` in the viewer panel. */
export async function openAppFromChat(
  assistantId: string,
  appId: string,
): Promise<void> {
  haptic.light();
  await useViewerStore.getState().loadApp(assistantId, appId);
}

/** Opens the document `surfaceId` under `assistantId` in the viewer panel. */
export async function openDocumentFromChat(
  assistantId: string,
  surfaceId: string,
): Promise<void> {
  haptic.light();
  await useViewerStore.getState().loadDocument(assistantId, surfaceId);
}

/**
 * Mobile document entry keeps the linked conversation's ordinary chat session.
 * `beforeOpen` dismisses the originating UI only once entry is ready.
 */
export function useOpenDocumentFromChat(
  ownerAssistantId?: string,
  beforeOpen?: () => void,
): (surfaceId: string) => Promise<void> {
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantId = ownerAssistantId ?? activeAssistantId;
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const location = useLocation();
  const { conversationId } = useParams<{ conversationId: string }>();
  const { t } = useTranslation("chat");
  const requestRef = useRef<ReturnType<typeof documentRequestScope> | null>(
    null,
  );

  useEffect(
    () => () => requestRef.current?.dispose(),
    [assistantId, location.key],
  );

  return useCallback(
    async (surfaceId) => {
      if (!assistantId) {
        return;
      }
      const route = getDocumentConversationRoute(location.search);
      if (!isMobile && (!conversationId || route.surfaceId !== surfaceId)) {
        beforeOpen?.();
        await openDocumentFromChat(assistantId, surfaceId);
        return;
      }
      requestRef.current?.dispose();
      const scope = documentRequestScope(assistantId);
      requestRef.current = scope;
      if (!scope.isCurrent()) {
        scope.dispose();
        return;
      }
      haptic.light();
      try {
        // The route owns this document, including any pending load or edits.
        if (conversationId && route.surfaceId === surfaceId) {
          beforeOpen?.();
          setDocumentConversationPresentation(navigate, {
            assistantId,
            conversationId,
            surfaceId,
            returnTo: route.returnTo,
            state: location.state,
            view: "document",
          });
          return;
        }
        await loadDocumentConversation({
          assistantId,
          surfaceId,
          isCurrent: scope.isCurrent,
          onReady: (data, linkedId) => {
            const returnTo = documentReturnPath(location.pathname);
            const state = documentEntryState(location, surfaceId);
            beforeOpen?.();
            if (linkedId) {
              navigateToDocumentConversation(
                navigate,
                data,
                linkedId,
                assistantId,
                returnTo,
                false,
                state,
              );
            } else {
              void navigate(documentEntryUrl(surfaceId, returnTo), { state });
            }
          },
        });
      } catch (error) {
        if (scope.isCurrent()) {
          captureError(error, { context: "open_document_from_chat" });
          toast.error(t("documentConversation.unavailable"));
        }
      } finally {
        scope.dispose();
      }
    },
    [assistantId, conversationId, isMobile, navigate, location, t, beforeOpen],
  );
}

/** An explicit open is a view action, so the split drops on the way in. */
function dropSplitView(): void {
  const viewer = useViewerStore.getState();
  if (viewer.mainView === "app-editing") {
    viewer.exitAppEditing();
  }
}

/**
 * Open an app in the viewer panel from inside the chat surface: the sidebar's
 * pinned-app click, the transcript's "Open App" affordance, and the chat
 * header's assets pill.
 *
 * Opening an app is a navigation to the URL that names it, which
 * `useAppRouteSync` answers for; with no conversation on screen a fresh draft
 * carries the app segment. An explicit open lands the app full width from
 * every entry point and on every viewport (LUM-2553).
 *
 * Re-opening the app the URL already names has nowhere to navigate, so it
 * reloads in place, which is how an app the assistant rewrites picks up its
 * new HTML. A reload the viewer gives up on drops the app segment from
 * whichever conversation the route names.
 *
 * Split view (`app-editing`) is an explicit choice made elsewhere: the
 * viewer's "Edit" affordance (`use-edit-app.ts`), selecting a conversation
 * beside an open app (`keepOpenAppBesideConversation`), and `set_view` from
 * the app itself (`app-viewer-actions.ts`). Each binds `editingConversationId`
 * itself, so this hook leaves it alone.
 *
 * Single source of truth for the active assistant's apps, used by
 * `chat-layout.tsx` (sidebar) and `chat-route-content.tsx` (transcript).
 * Don't inline a copy. A surface that opens an app for some other assistant
 * (the chat-info panel opens the one its payload names) calls
 * {@link openAppFromChat} with that assistant.
 */
export function useOpenAppFromChat(): (appId: string) => Promise<void> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // Assigned during render, not in an effect, so the callback reads the route
  // the user is on rather than the one it closed over.
  const latestPathnameRef = useRef(pathname);
  // eslint-disable-next-line react-hooks/refs -- render-phase sync so the async callback below reads the latest route
  latestPathnameRef.current = pathname;

  return useCallback(
    async (appId: string) => {
      if (!assistantId) {
        return;
      }
      haptic.light();
      if (appIdForPath(latestPathnameRef.current) === appId) {
        dropSplitView();
        const loaded = await useViewerStore
          .getState()
          .loadApp(assistantId, appId);
        const current = latestPathnameRef.current;
        const routeConversationId = conversationIdForPath(current);
        if (
          !loaded &&
          useViewerStore.getState().activeAppId !== appId &&
          appIdForPath(current) === appId &&
          routeConversationId
        ) {
          // An app the viewer cannot load does not belong in the URL, where
          // reload and a copied bookmark retry it forever. An `activeAppId`
          // still on the app means an overlay holds it, so the URL stands.
          await navigate(routes.conversation(routeConversationId), {
            replace: true,
          });
        }
        return;
      }
      const conversationId =
        useConversationStore.getState().activeConversationId ??
        prepareFreshConversation();
      dropSplitView();
      await navigate(routes.conversation(conversationId, appId));
    },
    [assistantId, navigate],
  );
}
