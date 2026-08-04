/**
 * Measures conversation switch to first transcript paint.
 *
 * `switchToConversation` opens a pending window at the instant the transcript
 * is blanked, and only for a real move between two conversations of the same
 * assistant; the chat panel closes it on the first render that is no longer an
 * empty loading transcript. One `client_switch.transcript_painted` sample per
 * switch, or one `client_switch.stalled` if the window outlives its TTL. Never
 * both: whichever lands first clears the pending window. A window whose history
 * fetch failed is abandoned without a sample.
 *
 * The TTL is 15s rather than the resume family's 10s because a cold history
 * fetch through the proxy chain can legitimately take that long on LTE. The
 * stall series is the denominator for "how often does a switch never paint",
 * not an error report.
 *
 * Metadata only: the conversation id is used to match a paint to its pending
 * window and never reaches an emitted detail bag.
 */

import { subscribe } from "@/lib/event-bus";
import { emitClientPerfEvent } from "@/lib/telemetry/client-perf";

const STALL_TTL_MS = 15_000;

let pending: {
  conversationId: string;
  at: number;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

function abandonPending(): void {
  if (pending === null) {
    return;
  }
  clearTimeout(pending.timer);
  pending = null;
}

/**
 * Opens the pending window. An impatient re-switch supersedes the previous
 * sample silently: counting superseded switches is deliberately out of scope.
 */
export function noteConversationSwitchStarted(conversationId: string): void {
  abandonPending();
  pending = {
    conversationId,
    at: performance.now(),
    timer: setTimeout(() => {
      pending = null;
      emitClientPerfEvent("client_switch.stalled", STALL_TTL_MS, {
        reason: "timeout",
      });
    }, STALL_TTL_MS),
  };
}

/**
 * Closes the pending window when the transcript for `conversationId` paints.
 * A paint for any other conversation is ignored and leaves the window open.
 */
export function noteSwitchTranscriptPainted(
  conversationId: string,
  extra: { hadHistory: boolean },
): void {
  if (pending === null || pending.conversationId !== conversationId) {
    return;
  }
  const elapsedMs = performance.now() - pending.at;
  abandonPending();
  emitClientPerfEvent("client_switch.transcript_painted", elapsedMs, {
    had_history: String(extra.hadHistory),
  });
}

/**
 * Drops the pending window without emitting anything. Used when the switch
 * neither painted nor stalled, so there is no sample to attribute to it.
 */
export function abandonSwitchMeasurement(): void {
  abandonPending();
}

/**
 * Abandons any pending window when the app is backgrounded, so a switch the
 * user walked away from never contaminates the p95. Returns an unsubscribe.
 */
export function subscribeSwitchTelemetry(): () => void {
  return subscribe("app.hidden", abandonPending);
}

export function __resetSwitchTelemetryForTests(): void {
  abandonPending();
}
