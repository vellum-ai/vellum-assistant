/**
 * Watchdog for a turn that has gone completely silent.
 *
 * The turn store's phase only leaves a sending state on a terminal signal
 * (`message_complete`, `assistant_activity_state(idle)`, cancel, error). When
 * every one of those is lost (the stream dies mid-turn, the daemon is killed,
 * a reconnect lands outside the replay ring), the phase stays in a sending
 * state indefinitely, which keeps the composer showing Stop instead of Send.
 * `onTurnTimeout` is the store's terminal transition for exactly that case; this
 * hook is what arms it.
 *
 * The timer measures silence, not turn duration: it is re-armed on every signal
 * that a turn is making progress, so a legitimately long turn never trips it.
 * Firing is deliberately paired with a history revalidation, because the local
 * phase is the less trustworthy half of the state: the refetched snapshot
 * carries the daemon's authoritative `processing` flag, so the UI converges on
 * server truth (still busy, or genuinely idle) rather than on a guess.
 *
 * Firing therefore runs the same two-store terminal transition every other
 * terminal path runs, via `endTurn`. Clearing the conversation's processing key
 * is not cosmetic: `useConversationHistory` counts that set into
 * `activeInProgress`, which gates its periodic `snapshotProcessing`
 * revalidation off. Idling only the turn store would leave the watchdog's own
 * one-shot refetch as the last word, so a conversation the daemon really did
 * finish would stay busy forever. Leaving it asserts nothing about the server:
 * if the daemon is still processing, the revalidation reseeds
 * `snapshotProcessing`, which re-drives busy and re-arms the poll that keeps
 * reconciling.
 */

import { useEffect } from "react";

import { useQueryClient } from "@tanstack/react-query";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { conversationHistoryQueryKey } from "@/domains/chat/transcript/use-history-pagination";
import { endTurn } from "@/domains/chat/turn-coordinator";
import { isSending, useTurnStore } from "@/domains/chat/turn-store";
import { recordDiagnostic } from "@/lib/diagnostics";

/**
 * How long a turn may go without a single progress signal before it is treated
 * as stranded. Every stream event for the active conversation advances the
 * rolling snapshot's `seq`, and turn-level transitions move the phase or the
 * tool-call count, so an active turn re-arms the timer continuously. Total
 * silence for this long means the client has lost the turn, not that the agent
 * is thinking: generous enough to sit out a slow tool call that emits nothing,
 * short enough that a wedged composer recovers without a reload.
 */
export const TURN_SILENCE_TIMEOUT_MS = 180_000;

interface UseTurnTimeoutParams {
  assistantId: string | null;
  activeConversationId: string | null;
  /** Overridable so tests can drive the watchdog without waiting it out. */
  timeoutMs?: number;
}

export function useTurnTimeout({
  assistantId,
  activeConversationId,
  timeoutMs = TURN_SILENCE_TIMEOUT_MS,
}: UseTurnTimeoutParams): void {
  const queryClient = useQueryClient();

  const phase = useTurnStore.use.phase();
  const activeTurnId = useTurnStore.use.activeTurnId();
  const activeToolCallCount = useTurnStore.use.activeToolCallCount();
  // Every event folded into the active conversation's snapshot advances `seq`,
  // making it the finest-grained progress signal available: text deltas, tool
  // output chunks, and activity-state updates all re-arm the timer through it
  // even when none of them change the turn phase.
  const snapshotSeq = useChatSessionStore((s) => s.snapshot?.seq ?? null);

  useEffect(() => {
    if (!isSending(phase)) {
      return;
    }
    const timer = setTimeout(() => {
      recordDiagnostic("turn_timeout_fired", {
        assistantId,
        conversationId: activeConversationId,
        phase,
        activeTurnId,
        activeToolCallCount,
        snapshotSeq,
        timeoutMs,
      });
      endTurn({ conversationId: activeConversationId, reason: "timeout" });
      if (assistantId && activeConversationId) {
        void queryClient.invalidateQueries({
          queryKey: conversationHistoryQueryKey(
            assistantId,
            activeConversationId,
          ),
        });
      }
    }, timeoutMs);
    return () => clearTimeout(timer);
  }, [
    phase,
    activeTurnId,
    activeToolCallCount,
    snapshotSeq,
    assistantId,
    activeConversationId,
    timeoutMs,
    queryClient,
  ]);
}
