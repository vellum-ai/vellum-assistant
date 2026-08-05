/**
 * Measures conversation switch to first transcript paint.
 *
 * `switchToConversation` opens a pending window at the instant the transcript
 * is blanked, and only for a real move between two conversations of the same
 * assistant; the chat panel closes it on the first render that is no longer an
 * empty loading transcript. Exactly one sample per opened window:
 * `client_switch.transcript_painted` when the transcript lands,
 * `client_switch.stalled` when the window outlives its TTL, or
 * `client_switch.abandoned` when the switch is cut short (history error, app
 * backgrounded, panel unmounted, a re-switch, or a move the family does not
 * measure). Painted plus stalled plus abandoned is therefore the full set of
 * measured switches, so no attempt silently leaves the denominator, apart from
 * subscription teardown, which drops an open window silently.
 *
 * The TTL is 15s rather than the resume family's 10s because a cold history
 * fetch through the proxy chain can legitimately take that long on LTE. The
 * stall series is the denominator for "how often does a switch never paint",
 * not an error report.
 *
 * Metadata only: the conversation id is used to match a paint to its pending
 * window and never reaches an emitted detail bag.
 */

import { useEffect } from "react";

import { subscribe } from "@/lib/event-bus";
import { emitClientPerfEvent } from "@/lib/telemetry/client-perf";

const STALL_TTL_MS = 15_000;

/**
 * Why a measured switch ended without painting. A closed set so the abandoned
 * series stays a groupable dimension rather than an open string.
 */
type SwitchAbandonReason =
  | "history_error"
  | "hidden"
  | "unmount"
  | "superseded"
  | "context_change"
  | "draft_resolution";

let pending: {
  conversationId: string;
  at: number;
  timer: ReturnType<typeof setTimeout>;
} | null = null;

/** Drops the window and its TTL without emitting anything. */
function clearPending(): void {
  if (pending === null) {
    return;
  }
  clearTimeout(pending.timer);
  pending = null;
}

/**
 * Closes the pending window with a `client_switch.abandoned` sample, so a
 * switch that never painted still lands in the family's denominator. A no-op
 * when no window is open, which is what makes it safe to call from render-path
 * effects and from store paths that may or may not have opened one.
 */
export function abandonSwitchMeasurement(reason: SwitchAbandonReason): void {
  if (pending === null) {
    return;
  }
  const elapsedMs = performance.now() - pending.at;
  clearPending();
  emitClientPerfEvent("client_switch.abandoned", elapsedMs, { reason });
}

/**
 * Opens the pending window. An impatient re-switch closes the previous window
 * as `superseded` rather than dropping it, so the abandoned rate stays honest.
 */
export function noteConversationSwitchStarted(conversationId: string): void {
  abandonSwitchMeasurement("superseded");
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
  clearPending();
  emitClientPerfEvent("client_switch.transcript_painted", elapsedMs, {
    had_history: extra.hadHistory,
  });
}

/**
 * Closes the pending window from the chat tree: reports the paint, vetoes it
 * when the history fetch failed, and abandons anything still open when the
 * panel goes away.
 *
 * The reporting effect is deliberately dependency-less. A switch into a
 * conversation whose history is already cached batches the transcript reset and
 * the cached snapshot into a single commit, so none of the values below have to
 * change between the switch and the paint; running on every commit is the only
 * way to observe that switch. Both calls are no-ops unless a window for
 * `conversationId` is open, so the extra invocations cost a comparison.
 */
export function useSwitchPaintMeasurement({
  conversationId,
  historyLoadFailed,
  transcriptPainted,
  hadHistory,
}: {
  conversationId: string | null;
  historyLoadFailed: boolean;
  transcriptPainted: boolean;
  hadHistory: boolean;
}): void {
  useEffect(() => {
    if (conversationId === null) {
      return;
    }
    if (historyLoadFailed) {
      abandonSwitchMeasurement("history_error");
      return;
    }
    if (transcriptPainted) {
      noteSwitchTranscriptPainted(conversationId, { hadHistory });
    }
  });

  useEffect(() => {
    return () => {
      abandonSwitchMeasurement("unmount");
    };
  }, []);
}

/**
 * Abandons any pending window when the app is backgrounded, so a switch the
 * user walked away from never contaminates the p95. The returned unsubscribe
 * also drops any window still open, so tearing the subscription down cannot
 * leave a TTL running with nothing left to close it.
 */
export function subscribeSwitchTelemetry(): () => void {
  const unsubscribe = subscribe("app.hidden", () => {
    abandonSwitchMeasurement("hidden");
  });
  return () => {
    unsubscribe();
    clearPending();
  };
}

export function __resetSwitchTelemetryForTests(): void {
  clearPending();
}
