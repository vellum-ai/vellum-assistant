/**
 * Handles actions a sandboxed app viewer dispatches through
 * `window.vellum.sendAction(actionId, data)`. Two independent actions:
 *
 * - `relay_prompt` ({ prompt, conversation?, conversationId? }) — sends `prompt` to a conversation
 *   via the `?prompt=` auto-send pathway (see `use-auto-send-effects.ts`).
 *   `conversation` is `"active"` (default, the open conversation) or `"new"` (a
 *   fresh draft). `conversationId` (a specific conversation ID string) takes
 *   precedence over both and navigates to that exact conversation. It never
 *   touches the layout. Each relay carries a unique token so the auto-send
 *   dedupe re-fires even when the same prompt is relayed repeatedly. No-op for
 *   `"active"` when no conversation is open.
 *
 * - `set_view` ({ view }) — moves the app panel: `"split"` (side by side with
 *   chat), `"full"` (full-width), or `"chat"` (close the app). Side-by-side has
 *   no mobile layout, so `"split"` is ignored on mobile (the app keeps its
 *   full-screen overlay).
 *
 * Stateless and framework-agnostic: stores are read via `getState()` and
 * navigation / viewport arrive through `ctx`, so this is unit-testable.
 */

import { createDraftConversationId } from "@/domains/chat/utils/conversation-selection";
import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
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
  if (!prompt) return;

  let conversationId: string | null;
  if (typeof data?.conversationId === "string" && data.conversationId) {
    // Navigate to a specific conversation by ID (e.g. a plugin that
    // manages its own conversation for assistant turns).
    conversationId = data.conversationId;
    useConversationStore.getState().setActiveConversationId(conversationId);
  } else if (data?.conversation === "new") {
    conversationId = createDraftConversationId();
    useConversationStore.getState().setActiveConversationId(conversationId);
  } else {
    conversationId = useConversationStore.getState().activeConversationId;
  }
  if (!conversationId) return;

  ctx.navigate(
    routes.conversationWithPrompt(conversationId, prompt, crypto.randomUUID()),
  );
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
      if (viewer.mainView === "app-editing") viewer.exitAppEditing();
      return;
    case "split": {
      if (ctx.isMobile) return;
      const conversationId =
        useConversationStore.getState().activeConversationId;
      if (!conversationId) return;
      useConversationStore.getState().setEditingConversationId(conversationId);
      viewer.enterAppEditing();
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
  } else if (actionId === "set_view") {
    setView(ctx, data);
  }
}
