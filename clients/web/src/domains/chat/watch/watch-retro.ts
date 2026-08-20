/**
 * The client half of what happens after a watch session stops: the wait for its
 * summary, and the question the surface asks once there is one.
 *
 * **A session ends twice.** The socket closes when the user presses stop, and
 * the account of the session is written afterwards, by a full agent turn that
 * runs for the better part of a minute
 * (`assistant/src/watch/watch-retro.ts`). Left alone the surface goes quiet
 * across that gap, which reads as the recording having been thrown away rather
 * than as work still in progress.
 *
 * **The answer cannot come back the way the audio went out.** The runtime sends
 * its terminal `closed` frame and tears the socket down *before* it dispatches
 * the retrospective, so by the time there is anything to report the transport
 * the user pressed stop on is gone. What is still open is the assistant's own
 * event stream, which this window already holds for everything else, and the
 * runtime announces the outcome there as `watch_retro_completed`.
 *
 * **The wait is bounded even so.** The runtime announces every outcome,
 * including the empty ones, so the ordinary end of a wait is an event rather
 * than a timer. The timer is for the cases where no event is coming at all: an
 * assistant old enough to run watch sessions without announcing their
 * retrospectives, a runtime that went away mid-turn, a stream that dropped for
 * longer than its replay buffer. A progress indicator that never resolves is
 * worse than one that gives up, because the surface it sits on floats over
 * whatever the user does next.
 *
 * **Held in the module, not in a component**, for the reason the session itself
 * is: it is started from the socket's teardown and drawn by a different
 * renderer, and it has to outlive every route the user walks through while the
 * turn runs.
 */

import { create } from "zustand";

import type { WatchRetroCompletedEvent } from "@vellumai/assistant-api";

/**
 * How long a summary may be pending before the wait is abandoned.
 *
 * Generous against the turn itself, which reads a session's worth of
 * accessibility trees and has been measured in the tens of seconds, and against
 * a runtime busy with something else when the retro is queued behind it. This
 * is not the turn's budget: the runtime's own announcement ends the wait
 * whenever it arrives, early or late. It is the ceiling on a wait for an
 * announcement that is never coming.
 */
const RETRO_TIMEOUT_MS = 180_000;

/**
 * The summary of a session that has ended, and where it has got to.
 *
 * `sessionId` is what the runtime's announcement is matched against, rather
 * than the conversation: a session can be started against a conversation it did
 * not mint, so two sessions can share one and the conversation would not tell
 * them apart.
 */
export interface WatchRetro {
  readonly sessionId: string;
  /** The conversation holding the report, and the one a yes opens. */
  readonly conversationId: string;
  /** `pending` while the turn runs, `ready` once there is a report. */
  readonly phase: "pending" | "ready";
}

interface WatchRetroState {
  /** The summary the surface is drawing, or `null` when there is none. */
  retro: WatchRetro | null;
}

export const useWatchRetroStore = create<WatchRetroState>(() => ({
  retro: null,
}));

/** The give-up timer for the pending summary, or null when none is pending. */
let timeoutTimer: ReturnType<typeof setTimeout> | null = null;

function clearTimeoutTimer(): void {
  if (timeoutTimer !== null) {
    clearTimeout(timeoutTimer);
    timeoutTimer = null;
  }
}

/**
 * Put the store back to having nothing to say.
 *
 * The one way the state ends, whichever reason ended it: answered, dismissed,
 * timed out, or announced as having produced nothing. Idempotent, so a
 * dismissal that races the runtime's own answer costs nothing.
 */
export function clearWatchRetro(): void {
  clearTimeoutTimer();
  if (useWatchRetroStore.getState().retro !== null) {
    useWatchRetroStore.setState({ retro: null });
  }
}

/**
 * A session has stopped and its summary is being written.
 *
 * Called on the stop edge rather than on the socket closing, because the point
 * of the pending state is that the user has just acted and the surface owes
 * them an answer about it. A session that never reached the runtime has nothing
 * to summarize and never gets here.
 *
 * Replaces whatever was pending. Only one session runs at a time, so a second
 * beginning means the first one's answer is no longer the one being waited on,
 * and leaving the old one up would ask about the wrong session.
 */
export function beginWatchRetro(session: {
  sessionId: string;
  conversationId: string;
}): void {
  clearTimeoutTimer();
  useWatchRetroStore.setState({
    retro: {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      phase: "pending",
    },
  });
  timeoutTimer = setTimeout(() => {
    timeoutTimer = null;
    const { retro } = useWatchRetroStore.getState();
    // Only a still-pending summary for this same session. A `ready` one is an
    // answered question waiting on the user, and the user gets as long as they
    // like.
    if (retro?.sessionId === session.sessionId && retro.phase === "pending") {
      console.warn(
        "watch-retro: no completion for the session summary, giving up",
      );
      useWatchRetroStore.setState({ retro: null });
    }
  }, RETRO_TIMEOUT_MS);
}

/**
 * The runtime has finished with a session's summary.
 *
 * Matched against the pending session and dropped otherwise, so a late
 * announcement for a session the user has already moved past cannot resurrect
 * its prompt or overwrite the one they are being asked now.
 *
 * `reportReady: false` clears rather than asks. The session recorded nothing,
 * or the turn produced no account of it, and in both cases the conversation was
 * deliberately left hidden by the runtime: offering to open it would be
 * offering an empty thread.
 */
export function settleWatchRetro(event: WatchRetroCompletedEvent): void {
  const { retro } = useWatchRetroStore.getState();
  if (retro === null || retro.sessionId !== event.sessionId) {
    return;
  }
  clearTimeoutTimer();
  if (!event.reportReady) {
    useWatchRetroStore.setState({ retro: null });
    return;
  }
  useWatchRetroStore.setState({
    retro: {
      sessionId: retro.sessionId,
      // The runtime's own answer rather than the id the session opened with:
      // the report is wherever it says it wrote it.
      conversationId: event.conversationId,
      phase: "ready",
    },
  });
}
