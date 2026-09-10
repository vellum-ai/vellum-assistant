/**
 * Handles actions a sandboxed app viewer dispatches through
 * `window.vellum.sendAction(actionId, data)`. Three independent actions:
 *
 * - `relay_prompt` ({ prompt, conversation, conversationId }): sends `prompt`
 *   to a conversation as the user. `conversation` is `"active"` (default, the
 *   open conversation) or `"new"` (a fresh draft); both go through the
 *   `?prompt=` auto-send pathway (see `use-auto-send-effects.ts`), so the
 *   prompt lands in whichever conversation the client is showing by the time
 *   the route mounts. `conversationId` names an existing conversation instead
 *   and wins over `conversation`: the host posts the prompt straight into that
 *   conversation through the user's own authenticated client, without
 *   navigating, so the send carries the user's identity, interface, and
 *   presence exactly like a typed message and cannot drift to another chat.
 *   Pair it with `open_conversation` to show the reply. Relaying never touches
 *   the layout. Each `?prompt=` relay carries a unique token so the auto-send
 *   dedupe re-fires even when the same prompt is relayed repeatedly. No-op for
 *   `"active"` when no conversation is open.
 *
 * - `open_conversation` ({ conversationId }) — navigates to an existing
 *   conversation by ID without sending a message. On a wide viewport the
 *   app stays open in the side-by-side layout so the conversation is
 *   visible. Used by plugins that manage their own background conversations
 *   (e.g. battleship) to let the user view the conversation from within the
 *   app UI.
 *
 * - `set_view` ({ view }) — moves the app panel: `"split"` (side by side with
 *   chat), `"full"` (full-width), or `"chat"` (close the app). Side-by-side has
 *   no mobile layout, so `"split"` is ignored on mobile (the app keeps its
 *   full-screen overlay). On a wide viewport it uses the open conversation,
 *   and starts one when none is open.
 *
 * Stateless and framework-agnostic: stores are read via `getState()` and
 * navigation / viewport arrive through `ctx`, so this is unit-testable.
 */

import { postChatMessage } from "@/domains/chat/api/messages";
import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { captureError } from "@/lib/sentry/capture-error";
import { useConversationStore } from "@/stores/conversation-store";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
import { useViewerStore } from "@/stores/viewer-store";
import { keepOpenAppBesideConversation } from "@/utils/conversation-navigation";
import { routes } from "@/utils/routes";

export interface AppViewerActionContext {
  /** Navigation from the route component, keeping this module framework-agnostic. */
  navigate: (to: string) => void;
  /** Side-by-side has no mobile layout, so `set_view: "split"` is ignored when true. */
  isMobile: boolean;
}

function relayPrompt(
  ctx: AppViewerActionContext,
  data?: Record<string, unknown>,
): void {
  const prompt = typeof data?.prompt === "string" ? data.prompt : "";
  if (!prompt) {
    return;
  }

  const targetConversationId =
    typeof data?.conversationId === "string" ? data.conversationId : "";
  if (targetConversationId) {
    relayPromptToConversation(targetConversationId, prompt);
    return;
  }

  let conversationId: string | null;
  if (data?.conversation === "new") {
    conversationId = createDraftConversationId();
    useConversationStore.getState().setActiveConversationId(conversationId);
  } else {
    conversationId = useConversationStore.getState().activeConversationId;
  }
  if (!conversationId) {
    return;
  }

  ctx.navigate(
    routes.conversationWithPrompt(conversationId, prompt, crypto.randomUUID()),
  );
}

/**
 * Post `prompt` into an existing conversation as the user, from the host.
 *
 * The sandboxed frame cannot reach `POST /v1/messages` itself (its fetch proxy
 * admits only the app's own `/v1/x/` routes), and an app backend that posts on
 * its behalf has no user to be: the daemon attributes such a turn to the app,
 * not to the person who clicked. Sending from the host keeps the click's
 * identity on the turn. The send is a plain post rather than the chat's
 * optimistic pipeline because the target need not be the conversation on
 * screen; when it is, the daemon's `user_message_echo` renders the row.
 *
 * Gated on a transient user activation, the same way the frame's other
 * host-mediated egress is (`vellum_open_link`): this reaches every
 * conversation the user owns, so a frame must not be able to fire it on load
 * or in a loop. An activation says the user clicked somewhere in the frame,
 * nothing more; see the accepted one-click path in `visual-surface.tsx`.
 */
function relayPromptToConversation(
  conversationId: string,
  prompt: string,
): void {
  if (!navigator.userActivation?.isActive) {
    return;
  }
  const assistantId = useResolvedAssistantsStore.getState().activeAssistantId;
  if (!assistantId) {
    return;
  }
  void postChatMessage(assistantId, conversationId, prompt)
    .then((result) => {
      if (!result.ok) {
        captureError(
          new Error(`relay_prompt send rejected: HTTP ${result.status}`),
          {
            context: "app_viewer_relay_prompt",
            extra: { conversationId },
          },
        );
      }
    })
    .catch((err: unknown) => {
      captureError(err, {
        context: "app_viewer_relay_prompt",
        extra: { conversationId },
      });
    });
}

/**
 * Select `conversationId` and land on it, keeping an open app beside it
 * rather than dismissing the app for the chat.
 */
function goToConversation(
  ctx: AppViewerActionContext,
  conversationId: string,
): void {
  useConversationStore.getState().setActiveConversationId(conversationId);
  keepOpenAppBesideConversation(conversationId);
  ctx.navigate(routes.conversation(conversationId));
}

function openConversation(
  ctx: AppViewerActionContext,
  data?: Record<string, unknown>,
): void {
  const conversationId =
    typeof data?.conversationId === "string" ? data.conversationId : "";
  if (!conversationId) {
    return;
  }
  goToConversation(ctx, conversationId);
}

function setView(
  ctx: AppViewerActionContext,
  data?: Record<string, unknown>,
): void {
  const viewer = useViewerStore.getState();
  switch (data?.view) {
    case "chat":
      viewer.closeApp();
      return;
    case "full":
      if (viewer.mainView === "app-editing") {
        viewer.exitAppEditing();
      }
      return;
    case "split": {
      if (ctx.isMobile) {
        return;
      }
      const conversationId =
        useConversationStore.getState().activeConversationId;
      if (conversationId) {
        keepOpenAppBesideConversation(conversationId);
        return;
      }
      // Split view is a chat beside the app, so it needs a conversation to
      // put there.
      goToConversation(ctx, createDraftConversationId());
      return;
    }
    default:
      return;
  }
}

export function handleAppViewerAction(
  ctx: AppViewerActionContext,
  actionId: string,
  data?: Record<string, unknown>,
): void {
  if (actionId === "relay_prompt") {
    relayPrompt(ctx, data);
  } else if (actionId === "open_conversation") {
    openConversation(ctx, data);
  } else if (actionId === "set_view") {
    setView(ctx, data);
  }
}
