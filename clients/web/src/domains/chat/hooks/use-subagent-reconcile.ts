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
 * Drafts are excluded: a conversation the server has never seen has no
 * subagents to reconcile against. Both triggers fire freely; the store decides
 * what actually goes out. A conversation-load pass is throttled per parent, so
 * a re-run costs nothing, while a reopen is issued even inside that window:
 * the stream it replaces is the one that may have dropped the terminal status,
 * and a reconcile skipped there is never retried. Reopens landing together
 * still collapse into a single round-trip.
 *
 * The version gate is read reactively rather than snapshotted: the assistant
 * version arrives asynchronously and is cleared on every assistant switch, so
 * a cold load routinely mounts this hook before it is known. Holding the
 * conversation-load pass until the version resolves is the difference between
 * that pass running late and it never running at all, the SSE trigger skips
 * `"fresh"` opens, and the unknown-id kick only fires for subagents that
 * stream something.
 */

import { useCallback, useEffect } from "react";

import {
  type SubagentReconcileTrigger,
  useSubagentStore,
} from "@/domains/chat/subagent-store";
import { useBusSubscription } from "@/hooks/use-bus-subscription";
import { useSupportsSubagentsReconcile } from "@/lib/backwards-compat/subagents-reconcile";
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
  const supportsReconcile = useSupportsSubagentsReconcile();

  const resync = useCallback(
    (trigger: SubagentReconcileTrigger) => {
      if (
        !supportsReconcile ||
        !assistantId ||
        !conversationId ||
        !conversationExistsOnServer
      ) {
        return;
      }
      void useSubagentStore
        .getState()
        .reconcileFromDaemon(assistantId, conversationId, trigger);
    },
    [
      supportsReconcile,
      assistantId,
      conversationId,
      conversationExistsOnServer,
    ],
  );

  useEffect(() => {
    resync("mount");
  }, [resync]);

  useBusSubscription("sse.opened", ({ assistantId: openedFor, cause }) => {
    if (!RESYNC_CAUSES.has(cause) || openedFor !== assistantId) {
      return;
    }
    resync("reopen");
  });
}
