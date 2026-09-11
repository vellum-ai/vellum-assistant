/**
 * Opening one of a conversation's surfaces in the viewer panel: an app through
 * {@link openAppFromChat}, a document through {@link openDocumentFromChat}.
 * Both buzz and hand off to the viewer store, so every entry point into the
 * viewer from chat feels the same. {@link useOpenAppFromChat} binds the app
 * helper to the active assistant, for the surfaces that do not name one.
 */

import { useCallback, useEffect, useRef } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "@vellumai/design-library/components/toast";

import { documentsByIdGet } from "@/generated/daemon/sdk.gen";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useTranslation } from "@/i18n";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { haptic } from "@/utils/haptics";
import { routes } from "@/utils/routes";

import {
  documentRequestScope,
  resolveDocumentConversation,
} from "../document-conversation";
import {
  DOCUMENT_RETURN_PARAM,
  documentReturnPath,
  navigateToDocumentConversation,
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

/** Mobile document entry keeps the linked conversation's ordinary chat session. */
export function useOpenDocumentFromChat(
  ownerAssistantId?: string,
): (surfaceId: string) => Promise<void> {
  const activeAssistantId = useResolvedAssistantsStore.use.activeAssistantId();
  const assistantId = ownerAssistantId ?? activeAssistantId;
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { t } = useTranslation("chat");
  const requestRef = useRef<ReturnType<typeof documentRequestScope> | null>(
    null,
  );

  useEffect(() => () => requestRef.current?.dispose(), [assistantId, pathname]);

  return useCallback(
    async (surfaceId) => {
      if (!assistantId) {
        return;
      }
      if (!isMobile) {
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
        const { data } = await documentsByIdGet({
          path: { assistant_id: assistantId, id: surfaceId },
          throwOnError: true,
        });
        if (!scope.isCurrent()) {
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
        const returnTo = documentReturnPath(pathname);
        if (linkedId) {
          navigateToDocumentConversation(
            navigate,
            data,
            linkedId,
            assistantId,
            returnTo,
          );
        } else {
          const params = new URLSearchParams({
            [DOCUMENT_RETURN_PARAM]: returnTo,
          });
          void navigate(`${routes.document(surfaceId)}?${params}`);
        }
      } catch (error) {
        if (scope.isCurrent()) {
          captureError(error, { context: "open_document_from_chat" });
          toast.error(t("documentConversation.unavailable"));
        }
      } finally {
        scope.dispose();
      }
    },
    [assistantId, isMobile, navigate, pathname, t],
  );
}

/**
 * Open an app in the viewer panel from inside the chat surface: the sidebar's
 * pinned-app click and the transcript's "Open App" affordance.
 *
 * Opening an app is a *view* action, so the app lands full-width:
 * `loadApp` sets `mainView` to `"app"` and nothing here upgrades it. That
 * holds on every viewport, with or without an active conversation, so the
 * app opens the same way from chat as it does from Home / Library rather
 * than the layout depending on the entry point (LUM-2553).
 *
 * Split view (`app-editing`: chat on the left, app on the right) is an
 * explicit choice, never a side effect of opening:
 * - the user picks it through the viewer's "Edit" affordance
 *   (`use-edit-app.ts`), which binds a per-app edit conversation;
 * - the user selects a conversation while an app is already open
 *   (`keepOpenAppBesideConversation`), which binds that conversation;
 * - the app requests it through `set_view({ view: "split" })`
 *   (`app-viewer-actions.ts`), which binds the active conversation.
 *
 * Those paths bind `editingConversationId` themselves, and that value is only
 * read while `mainView` is `"app-editing"`, so this hook leaves it alone.
 *
 * Returns a stable async callback `(appId: string) => Promise<void>` safe
 * to drop into deps arrays.
 *
 * Single source of truth for the active assistant's apps, used by
 * `chat-layout.tsx` (sidebar) and `chat-route-content.tsx` (transcript).
 * Don't inline a copy. A surface that opens an app for some other assistant
 * (the chat-info panel opens the one its payload names) calls
 * {@link openAppFromChat} with that assistant.
 */
export function useOpenAppFromChat(): (appId: string) => Promise<void> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  return useCallback(
    async (appId: string) => {
      if (!assistantId) {
        return;
      }
      await openAppFromChat(assistantId, appId);
    },
    [assistantId],
  );
}
