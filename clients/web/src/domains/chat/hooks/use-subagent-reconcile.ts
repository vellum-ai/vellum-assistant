/**
 * Resync the subagent store against the daemon whenever this client's picture
 * of a run could have gone stale.
 *
 * Two triggers:
 *
 * - **Conversation load.** The transcript's history notifications only name
 *   subagents that reached a message; one that is still mid-run and has
 *   streamed nothing leaves no trace in history at all. A reload during that
 *   window would show no row for it (and no Active-Subagents overlay entry)
 *   until it finally emitted something. One reconcile round-trip rebuilds the
 *   rows from the daemon's live state instead.
 *
 * - **SSE reopen.** A connection that dropped past the daemon's replay ring can
 *   miss a terminal `subagent_status_changed`, leaving the entry stuck
 *   `running` with a live overlay and a Stop control that does nothing.
 *   `"fresh"` and `"anchor"` opens are skipped: the conversation-load effect
 *   owns the initial load, and an anchored reopen is caught up by the daemon's
 *   ring replay.
 *
 * Drafts are excluded — a conversation the server has never seen has no
 * subagents to reconcile against.
 */

import { useEffect } from "react";

import { useSubagentStore } from "@/domains/chat/subagent-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import type { BusEventPayload } from "@/lib/event-bus";

type SseOpenedCause = BusEventPayload<"sse.opened">["cause"];

const RESYNC_CAUSES: ReadonlySet<SseOpenedCause> = new Set<SseOpenedCause>([
  "resume",
  "watchdog",
  "error",
  "debug",
]);

export function useSubagentReconcile(
  assistantId: string | null,
  conversationId: string | null,
  conversationExistsOnServer: boolean,
): void {
  useEffect(() => {
    if (!assistantId || !conversationId || !conversationExistsOnServer) {
      return;
    }
    void useSubagentStore
      .getState()
      .reconcileFromDaemon(assistantId, conversationId);
  }, [assistantId, conversationId, conversationExistsOnServer]);

  useBusSubscription("sse.opened", ({ assistantId: openedFor, cause }) => {
    if (!RESYNC_CAUSES.has(cause)) {
      return;
    }
    if (!assistantId || !conversationId || !conversationExistsOnServer) {
      return;
    }
    if (openedFor !== assistantId) {
      return;
    }
    void useSubagentStore
      .getState()
      .reconcileFromDaemon(assistantId, conversationId);
  });
}
