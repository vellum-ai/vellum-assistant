/**
 * `useLiveActivityControls()` — applies iOS Live Activity button presses to the
 * running live-voice session.
 *
 * The inbound half of the island. {@link useLiveActivityMirror} pushes what the
 * session *is* out to the Dynamic Island and Lock Screen; this takes what the
 * user asks of it from there — mute the mic, mute the assistant, end it — and
 * runs it through the same store controls the voice room's own control row
 * uses. One set of semantics for both surfaces, so a mute from a locked phone
 * and a mute from the room are the same operation and cannot drift.
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
 * No-ops off iOS and on a shell too old to send the events, through
 * `subscribeVoiceLiveActivityControl`'s skew contract.
 */

import { useEffect } from "react";

import {
  endLiveVoiceSession,
  isLiveVoiceSessionActive,
  setLiveVoiceMuted,
  setLiveVoiceOutputMuted,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  subscribeVoiceLiveActivityControl,
  type VoiceLiveActivityControlAction,
} from "@/runtime/native-live-activity";

/**
 * Run one island action against the live session.
 *
 * **Every mute is resolved against store state read right now**, never against
 * anything the island sent. The two mute actions are toggles for exactly this
 * reason: the island can be rendering a content state several seconds old, and
 * on the APNs path one composed without `outputMuted` at all, so an absolute
 * "mute" command derived from what the user saw would be wrong precisely when
 * the island was wrong. Reading the store here makes the button correct
 * whatever it was drawn from.
 *
 * Exported for its tests; the hook is the only caller.
 */
export function applyLiveActivityControl(
  action: VoiceLiveActivityControlAction,
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
    case "toggleMicrophone":
      setLiveVoiceMuted(!session.muted);
      return;
    case "toggleAssistantAudio":
      setLiveVoiceOutputMuted(!session.outputMuted);
      return;
    case "endSession":
      endLiveVoiceSession();
      return;
    default:
      // An action from a shell newer than this bundle. Ignoring it is the only
      // safe reading: these are commands against a live call, and guessing at
      // one is worse than dropping it.
      action satisfies never;
  }
}

export function useLiveActivityControls(): void {
  useEffect(
    () => subscribeVoiceLiveActivityControl(({ action }) => {
      applyLiveActivityControl(action);
    }),
    [],
  );
}
