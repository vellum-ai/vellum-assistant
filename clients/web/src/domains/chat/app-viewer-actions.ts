/**
 * Handles actions a sandboxed app viewer dispatches through
 * `window.vellum.sendAction(actionId, data)`.
 *
 * Today the only action is `relay_prompt`: inject `data.prompt` into the
 * active conversation via the `?prompt=` auto-send pathway (see
 * `use-auto-send-effects.ts`). The current layout is preserved — a full-width
 * app stays full-width, the side-by-side `app-editing` split stays split — so
 * relaying never yanks the user to a different view. An app may pass
 * `view: "chat"` to close the viewer and focus the conversation instead.
 *
 * No-op when no conversation is active (e.g. an app opened from the library
 * with no chat to relay into).
 *
 * Stateless and framework-agnostic: stores are read via `getState()` and
 * navigation arrives through `ctx`, so this is unit-testable without React.
 */

import { useConversationStore } from "@/stores/conversation-store";
import { useViewerStore } from "@/stores/viewer-store";
import { routes } from "@/utils/routes";

interface RelayPrompt {
  prompt: string;
  /** Optional layout override; omitted preserves the current view. */
  view?: "chat";
}

function parseRelayPrompt(data: unknown): RelayPrompt | null {
  if (typeof data !== "object" || data === null) return null;
  const { prompt, view } = data as { prompt?: unknown; view?: unknown };
  if (typeof prompt !== "string" || prompt.length === 0) return null;
  return { prompt, view: view === "chat" ? "chat" : undefined };
}

export interface AppViewerActionContext {
  /** Navigation provided by the route component, keeping this module framework-agnostic. */
  navigate: (to: string) => void;
}

export function handleAppViewerAction(
  ctx: AppViewerActionContext,
  actionId: string,
  data?: Record<string, unknown>,
): void {
  if (actionId !== "relay_prompt") return;

  const relay = parseRelayPrompt(data);
  if (!relay) return;

  const conversationId = useConversationStore.getState().activeConversationId;
  if (!conversationId) return;

  if (relay.view === "chat") {
    useViewerStore.getState().closeApp();
  }

  ctx.navigate(routes.conversationWithPrompt(conversationId, relay.prompt));
}
