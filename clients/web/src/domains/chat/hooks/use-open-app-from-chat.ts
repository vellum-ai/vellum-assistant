/**
 * Opening one of a conversation's surfaces in the viewer panel.
 * {@link openDocumentFromChat} buzzes and hands a document to the viewer
 * store, so every entry point into the viewer from chat feels the same.
 * {@link useOpenAppFromChat} opens an app for the active assistant by
 * navigating to the URL that names it.
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
import {
  currentPathname,
  dropFailedAppFromRoute,
  prepareFreshConversation,
} from "@/utils/conversation-navigation";
import {
  documentEntryState,
  documentEntryUrl,
} from "@/utils/document-navigation";
import { appIdForPath, isConversationChatPath, routes } from "@/utils/routes";

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

/**
 * An explicit open is a view action, so the split drops on the way in, and
 * the chat pane bound beside the app goes with it.
 */
function dropSplitView(): void {
  const viewer = useViewerStore.getState();
  if (viewer.mainView !== "app-editing") {
    return;
  }
  viewer.exitAppEditing();
  useConversationStore.getState().setEditingConversationId(null);
}

/**
 * The conversation the app segment hangs off. Off a chat route the click came
 * from Library, Home or the inspector, where `activeConversationId` names
 * whatever the SSE and attention consumers keep it on rather than anything the
 * user is looking at, so a fresh draft carries the app instead (LUM-2691).
 */
function conversationForApp(): string {
  const selected = isConversationChatPath(currentPathname())
    ? useConversationStore.getState().activeConversationId
    : null;
  return selected ?? prepareFreshConversation();
}

/**
 * Open an app in the viewer panel from inside the chat surface: the sidebar's
 * pinned-app click, the transcript's "Open App" affordance, and the chat
 * header's assets pill.
 *
 * The open is a navigation to the URL that names the app, which
 * `useAppRouteSync` answers for. An explicit open lands the app full width
 * from every entry point and on every viewport (LUM-2553), and off a chat
 * route the app hangs off a fresh draft rather than whatever conversation the
 * store still names (LUM-2691).
 *
 * Re-opening the app the URL already names has nowhere to navigate, so it
 * reloads in place, which is how an app the assistant rewrites picks up its
 * new HTML. A reload the viewer gives up on drops the app segment.
 */
export function useOpenAppFromChat(): (appId: string) => Promise<void> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const navigate = useNavigate();

  return useCallback(
    async (appId: string) => {
      if (!assistantId) {
        return;
      }
      haptic.light();
      // Ahead of the conversation choice: the reveal a fresh draft runs enters
      // the split this open drops.
      dropSplitView();
      if (appIdForPath(currentPathname()) === appId) {
        const loaded = await useViewerStore
          .getState()
          .loadApp(assistantId, appId);
        if (!loaded) {
          dropFailedAppFromRoute(navigate, appId);
        }
        return;
      }
      await navigate(routes.conversation(conversationForApp(), appId));
    },
    [assistantId, navigate],
  );
}
