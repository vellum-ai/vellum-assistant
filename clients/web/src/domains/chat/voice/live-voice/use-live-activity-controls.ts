/**
 * `useLiveActivityControls()` — applies iOS Live Activity button presses to the
 * running live-voice session.
 *
 * The inbound half of the island. {@link useLiveActivityMirror} pushes what the
 * session *is* out to the Dynamic Island and Lock Screen; this takes what the
 * user asks of it from there — mute the mic, mute the assistant, end it, and
 * answer the confirmation a turn is blocked on — and runs each through the same
 * path the app's own surfaces use: the store controls behind the voice room's
 * control row, and {@link handleConfirmationSubmit} behind the approval card's
 * Allow and Deny. One set of semantics for both surfaces, so a decision from a
 * locked phone and a decision from the room are the same operation and cannot
 * drift.
 *
 * **A separate module from the mirror, deliberately.** That one is documented
 * as never reaching the session: it is an optional platform flourish, and
 * everything in it is fire-and-forget precisely so a broken island cannot
 * damage a call. This module is the opposite — its entire job is to reach the
 * session — and folding it in would quietly retire that invariant. Mounted
 * beside it by {@link useLiveVoiceSessionController}, so its lifetime is
 * exactly the session's; a press that arrives with no session mounted has
 * nothing listening and does nothing (nothing native queues them).
 *
 * **Both out-of-app surfaces feed this one path.** The iOS island's App Intent
 * presses and the macOS floating panel's button presses carry the same action
 * vocabulary and mean the same thing, so they are applied by the same function
 * rather than each growing its own handling. The drift this avoids is two
 * surfaces disagreeing about what "mute" does mid-call.
 *
 * No-ops off iOS, off Electron, and on a shell too old to send the events,
 * through each subscription's skew contract.
 */

import { useEffect } from "react";

import {
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  setLiveVoiceMuted,
  setLiveVoiceOutputMuted,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import { handleConfirmationSubmit } from "@/domains/chat/confirmation-actions";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import {
  subscribeVoiceLiveActivityControl,
  type VoiceLiveActivityControlAction,
} from "@/runtime/native-live-activity";
import { subscribeVoiceActivityControl } from "@/runtime/desktop-voice-activity";
import type { ConfirmationDecision } from "@/types/event-types";

/**
 * Answer the confirmation the island's Approve/Deny buttons were drawn
 * against, or drop the press.
 *
 * **The press must name a request, and it must be the one still pending.** The
 * mutes above apply what the button promised because a stale mute is a
 * harmless no-op; a stale approval is not. Between the push that drew the
 * buttons and the press that answers them the request can be decided in the
 * app, time out into the daemon's 45-second fallback, or be superseded — and
 * the next one to arrive would be a different question wearing the same
 * buttons. Answering the named request or nothing is the only reading that
 * cannot approve something the user never saw.
 *
 * Beyond the id check this is the app's own path, not a second one:
 * {@link handleConfirmationSubmit} is exactly what the approval card's Allow
 * and Deny call, so an island decision and a card decision are the same
 * operation — same POST, same transcript stamping, same stale-prompt handling.
 * The island has no credential and no endpoint of its own, which is the whole
 * reason an intent performed in the app process is the right shape for this.
 */
function answerFromIsland(
  decision: ConfirmationDecision,
  requestId: string | undefined,
): void {
  const pending = useInteractionStore.getState().pendingConfirmation;
  if (
    requestId === undefined ||
    pending === null ||
    pending.requestId !== requestId
  ) {
    return;
  }
  void handleConfirmationSubmit(decision);
}

/**
 * Run one island action against the live session.
 *
 * **The action carries the state the button promised, and that state is applied
 * verbatim.** The island can be rendering content several seconds old — and on
 * the APNs path content composed without `outputMuted` at all — so resolving a
 * toggle against live store state here would be self-consistent and still wrong
 * for the user: a button reading "Mute assistant" over an already-muted session
 * would unmute it, the exact opposite of what it offered. Applying what the
 * button said turns that press into a no-op the next push corrects.
 *
 * Exported for its tests; the hook is the only caller.
 */
export function applyLiveActivityControl(
  action: VoiceLiveActivityControlAction,
  requestId?: string,
): void {
  const session = useLiveVoiceStore.getState();
  // A press against a session that has already ended does nothing. The island
  // outlives the session by the moment it takes ActivityKit to dismiss it, and
  // an end landing in that window must not tear down a session the user has
  // since started.
  if (!isLiveVoiceSessionActive(session.state)) {
    return;
  }
  switch (action) {
    case "muteMicrophone":
      setLiveVoiceMuted(true);
      return;
    case "unmuteMicrophone":
      setLiveVoiceMuted(false);
      return;
    case "muteAssistantAudio":
      setLiveVoiceOutputMuted(true);
      return;
    case "unmuteAssistantAudio":
      setLiveVoiceOutputMuted(false);
      return;
    case "endSession":
      endLiveVoiceSession();
      return;
    case "approveRequest":
      answerFromIsland("allow", requestId);
      return;
    case "denyRequest":
      answerFromIsland("deny", requestId);
      return;
    default:
      // An action from a shell newer than this bundle. Ignoring it is the only
      // safe reading: these are commands against a live call, and guessing at
      // one is worse than dropping it.
      action satisfies never;
  }
}

export function useLiveActivityControls(): void {
  useEffect(() => {
    const apply = ({
      action,
      requestId,
    }: {
      action: VoiceLiveActivityControlAction;
      requestId?: string;
    }): void => {
      applyLiveActivityControl(action, requestId);
    };
    // Both surfaces, one set of semantics. Each subscription no-ops off its own
    // host, so at most one ever fires, but they are subscribed unconditionally
    // rather than behind a platform branch, for the same reason the mirror
    // pushes to both sinks: the host test belongs in the runtime module, not
    // duplicated at every call site.
    const unsubscribeIsland = subscribeVoiceLiveActivityControl(apply);
    const unsubscribePanel = subscribeVoiceActivityControl(apply);
    return () => {
      unsubscribeIsland();
      unsubscribePanel();
    };
  }, []);
}
