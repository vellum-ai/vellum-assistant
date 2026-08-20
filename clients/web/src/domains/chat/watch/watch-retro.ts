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
 *
 * **But it belongs to one assistant, the way the session did.** The wait ends
 * on an event from the assistant that ran the session, and the SSE service
 * detaches from that assistant the moment the user switches away, so a pending
 * wait carried across a switch can never be settled and would sit until the
 * give-up timer. A ready one is worse than stuck: the question would be drawn
 * under the new assistant's name, and answering yes would navigate to a
 * conversation that belongs to the old one while every request the app makes is
 * scoped to the new one. So the state is bound to its assistant on the same
 * terms `watch-controller.ts` binds the session, and ends the same way when
 * that assistant stops being the active one.
 */

import { create } from "zustand";

import type { WatchRetroCompletedEvent } from "@vellumai/assistant-api";

import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";

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
  /**
   * The assistant that ran the session, which is the only one that can settle
   * this wait and the only one the report's conversation exists under.
   */
  readonly assistantId: string;
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
 * Watches for the owning assistant ceasing to be the active one, for exactly as
 * long as there is something to own. Null when there is nothing outstanding.
 */
let ownerSubscription: (() => void) | null = null;

function releaseOwnerSubscription(): void {
  if (ownerSubscription !== null) {
    ownerSubscription();
    ownerSubscription = null;
  }
}

/**
 * Bind the outstanding summary to `assistantId` and drop it if the user moves
 * to another assistant.
 *
 * The same subscription `watch-controller.ts` puts on a running session, for
 * the same reason and with the same reading of ambiguity: a move to no active
 * assistant counts, and the safe answer is to stop claiming anything. A pending
 * wait cannot be settled once the event stream it was waiting on is detached,
 * and a ready one would ask the wrong assistant's question.
 */
function bindToOwner(assistantId: string): void {
  releaseOwnerSubscription();
  ownerSubscription = useResolvedAssistantsStore.subscribe((state) => {
    if (state.activeAssistantId !== assistantId) {
      console.info(
        "watch-retro: dropping the session summary, its assistant is no longer active",
      );
      clearWatchRetro();
    }
  });
}

/**
 * Put the store back to having nothing to say.
 *
 * The one way the state ends, whichever reason ended it: answered, dismissed,
 * timed out, the owning assistant being switched away from, or announced as
 * having produced nothing. Idempotent, so a dismissal that races the runtime's
 * own answer costs nothing.
 */
export function clearWatchRetro(): void {
  clearTimeoutTimer();
  releaseOwnerSubscription();
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
  assistantId: string;
}): void {
  clearTimeoutTimer();
  bindToOwner(session.assistantId);
  useWatchRetroStore.setState({
    retro: {
      sessionId: session.sessionId,
      conversationId: session.conversationId,
      assistantId: session.assistantId,
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
      clearWatchRetro();
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
    clearWatchRetro();
    return;
  }
  useWatchRetroStore.setState({
    retro: {
      sessionId: retro.sessionId,
      // The runtime's own answer rather than the id the session opened with:
      // the report is wherever it says it wrote it.
      conversationId: event.conversationId,
      // Unchanged: settling tells the wait where the report landed, not who it
      // belongs to. The owner subscription bound at `beginWatchRetro` stays up
      // through the ready phase, because a question waiting on the user is
      // exactly as wrong to carry across a switch as a wait waiting on an event.
      assistantId: retro.assistantId,
      phase: "ready",
    },
  });
}
