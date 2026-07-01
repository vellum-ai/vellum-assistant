/**
 * User reactions on assistant messages — client data layer.
 *
 * Reaction state lives on the message row in the chat snapshot (the wire
 * `reactions` field), so there is no separate query cache: the toggle
 * optimistically patches the snapshot and the daemon's
 * `message_reaction_updated` SSE event (full replacement set) reconverges
 * every client, including this one.
 */

import { useCallback, useSyncExternalStore } from "react";

import type { ConversationMessageReaction } from "@vellumai/assistant-api";
import { toast } from "@vellumai/design-library";
import { patchTranscriptMessages } from "@/domains/chat/transcript/patch-transcript-messages";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { messagereactionsPost } from "@/generated/daemon/sdk.gen";
import { captureError } from "@/lib/sentry/capture-error";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

/** Actor recorded on reactions the user places from this client. */
export const USER_REACTION_ACTOR = "user";

/** Quick-reaction emoji offered in the hover popover. */
export const QUICK_REACTION_EMOJI = ["👍", "❤️", "🎉", "😂", "😮", "🙏"];

// Daemons that predate `POST /v1/message-reactions` return 404. The first
// such failure flips this session-scoped flag so the reaction affordance
// hides instead of repeatedly offering an action the connected assistant
// can't perform — the same 404-tolerant handling the inspector applies to
// older daemons.
let reactionsUnsupported = false;
const supportListeners = new Set<() => void>();

function markReactionsUnsupported(): void {
  if (reactionsUnsupported) {
    return;
  }
  reactionsUnsupported = true;
  for (const listener of supportListeners) {
    listener();
  }
}

function subscribeToSupport(listener: () => void): () => void {
  supportListeners.add(listener);
  return () => supportListeners.delete(listener);
}

/** False once the connected assistant has answered 404 to a reaction write. */
export function useReactionsSupported(): boolean {
  return useSyncExternalStore(
    subscribeToSupport,
    () => !reactionsUnsupported,
    () => true,
  );
}

/** Whether the user has already placed `emoji` on `message`. */
export function hasUserReaction(
  message: DisplayMessage,
  emoji: string,
): boolean {
  return (message.reactions ?? []).some(
    (r) => r.actor === USER_REACTION_ACTOR && r.emoji === emoji,
  );
}

/**
 * Patch a message's reactions in both transcript sources (materialized
 * snapshot + history cache) so the optimistic write survives a cache
 * reseed and reaches rows on older history pages.
 */
function patchMessageReactions(
  messageId: string,
  updater: (
    prev: ConversationMessageReaction[],
  ) => ConversationMessageReaction[],
): void {
  patchTranscriptMessages((prev) =>
    prev.map((m) =>
      m.id === messageId || (m.mergedMessageIds?.includes(messageId) ?? false)
        ? { ...m, reactions: updater(m.reactions ?? []) }
        : m,
    ),
  );
}

/**
 * Returns a stable `toggle(message, emoji)` that adds or removes the user's
 * reaction with an optimistic snapshot patch (rolled back on error). The
 * server's `message_reaction_updated` event carries the authoritative set.
 */
export function useUserReactionToggle(
  conversationId?: string | null,
): (message: DisplayMessage, emoji: string) => Promise<void> {
  const assistantId = useResolvedAssistantsStore.use.activeAssistantId();

  return useCallback(
    async (message, emoji) => {
      if (!assistantId || !conversationId || !message.id) {
        return;
      }
      const op = hasUserReaction(message, emoji) ? "remove" : "add";
      const previous = message.reactions ?? [];

      patchMessageReactions(message.id, (list) =>
        op === "add"
          ? [
              ...list,
              { emoji, actor: USER_REACTION_ACTOR, createdAt: Date.now() },
            ]
          : list.filter(
              (r) => !(r.actor === USER_REACTION_ACTOR && r.emoji === emoji),
            ),
      );

      try {
        const { response, error } = await messagereactionsPost({
          path: { assistant_id: assistantId },
          body: { conversationId, messageId: message.id, emoji, op },
        });
        if (error === undefined) {
          return;
        }
        patchMessageReactions(message.id, () => previous);
        // The reactions route itself answers 404 for a missing *message*
        // (its NotFoundError bodies name the message) — only a 404 without
        // that marker indicates the endpoint doesn't exist on this daemon.
        const errorText =
          typeof error === "object" && error !== null
            ? JSON.stringify(error)
            : String(error);
        const isMessageLevel404 =
          errorText.includes("not found in conversation") ||
          errorText.includes("no longer exists");
        if (response?.status === 404 && !isMessageLevel404) {
          markReactionsUnsupported();
          toast.error(
            "Your assistant doesn't support reactions yet — update it to react to messages.",
          );
          return;
        }
        captureError(error, { context: "message_reaction_toggle" });
        toast.error(
          op === "add"
            ? "Failed to add reaction."
            : "Failed to remove reaction.",
        );
      } catch (error) {
        patchMessageReactions(message.id, () => previous);
        captureError(error, { context: "message_reaction_toggle" });
        toast.error(
          op === "add"
            ? "Failed to add reaction."
            : "Failed to remove reaction.",
        );
      }
    },
    [assistantId, conversationId],
  );
}
