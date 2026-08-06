/**
 * Tests for `applyLiveActivityControl` — what an iOS Live Activity button does
 * to the running session.
 *
 * The subject is the resolution step, not the bridge. Two rules meet here and
 * they pull in opposite directions:
 *
 * - **A mute is applied exactly as the button promised.** The island can be
 *   seconds stale — and on the APNs path is composed without `outputMuted` at
 *   all — so a toggle resolved against live state would be self-consistent and
 *   still invert what the user asked for. Applying the button's own state makes
 *   a stale press a no-op instead.
 * - **A decision is applied only to the request it named.** The same staleness
 *   that makes a mute harmless makes an approval dangerous: the request behind
 *   the buttons can be answered, time out, or be superseded, and the next one
 *   would inherit the press.
 *
 * The bridge subscription itself (off-iOS and older-shell no-ops) is pinned by
 * `runtime/native-live-activity.test.ts`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

const handleConfirmationSubmit = mock(async () => undefined);
mock.module("@/domains/chat/confirmation-actions", () => ({
  handleConfirmationSubmit,
}));

import { applyLiveActivityControl } from "@/domains/chat/voice/live-voice/use-live-activity-controls";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import {
  useLiveVoiceStore,
  type LiveVoiceSessionControls,
  type LiveVoiceSessionState,
} from "@/domains/chat/voice/live-voice/live-voice-store";

const controls = {
  stop: mock(() => undefined),
  release: mock(() => undefined),
  interrupt: mock(() => undefined),
  setMuted: mock(() => undefined),
  setOutputMuted: mock(() => undefined),
  updateConfig: mock(() => undefined),
  attachImage: mock(() => true),
} satisfies LiveVoiceSessionControls;

function session(
  state: LiveVoiceSessionState,
  patch: { muted?: boolean; outputMuted?: boolean } = {},
): void {
  useLiveVoiceStore.setState({
    state,
    muted: false,
    outputMuted: false,
    controls,
    ...patch,
  });
}

/** Put a confirmation on screen for the island's buttons to answer. */
function pendingConfirmation(requestId: string): void {
  useInteractionStore.getState().showConfirmation({
    requestId,
    toolName: "bash",
    input: {},
  });
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  useInteractionStore.getState().dismissConfirmation();
  handleConfirmationSubmit.mockClear();
  for (const control of Object.values(controls)) {
    control.mockClear();
  }
});

describe("applyLiveActivityControl", () => {
  test("the mic button mutes an unmuted session", () => {
    session("listening");
    applyLiveActivityControl("muteMicrophone");
    expect(controls.setMuted).toHaveBeenCalledWith(true);
  });

  test("a mute press against an already-muted session is a no-op, not an inversion", () => {
    // The island renders "muted" from content that may be seconds old, so a
    // button reading "Mute" can be drawn over a session that already is. It
    // applies what it promised — leaving the session muted — where a toggle
    // would have unmuted, which is the opposite of what the user pressed.
    session("listening", { muted: true });
    applyLiveActivityControl("muteMicrophone");
    expect(controls.setMuted).toHaveBeenCalledWith(true);
    expect(controls.setMuted).not.toHaveBeenCalledWith(false);
  });

  test("the speaker button unmutes the assistant when that is what it offered", () => {
    session("speaking", { outputMuted: true });
    applyLiveActivityControl("unmuteAssistantAudio");
    expect(controls.setOutputMuted).toHaveBeenCalledWith(false);
  });

  test("a speaker press applies the button's state even when the island's copy was wrong", () => {
    // The APNs path composes content with no `outputMuted` in it at all, so an
    // island driven by the server draws "Mute assistant" over a session that
    // is already muted. The press must leave it muted rather than undo it.
    session("speaking", { outputMuted: true });
    applyLiveActivityControl("muteAssistantAudio");
    expect(controls.setOutputMuted).toHaveBeenCalledWith(true);
    expect(controls.setOutputMuted).not.toHaveBeenCalledWith(false);
  });

  test("approve answers the confirmation the button named", () => {
    session("thinking");
    pendingConfirmation("req-1");
    applyLiveActivityControl("approveRequest", "req-1");
    expect(handleConfirmationSubmit).toHaveBeenCalledWith("allow");
  });

  test("deny answers the confirmation the button named", () => {
    session("thinking");
    pendingConfirmation("req-1");
    applyLiveActivityControl("denyRequest", "req-1");
    expect(handleConfirmationSubmit).toHaveBeenCalledWith("deny");
  });

  test("a decision aimed at a superseded request is dropped, not re-pointed", () => {
    // The whole reason the id travels. Between the push that drew the buttons
    // and the press that answered them, the first request was decided in the
    // app and a second one took its place. Approving here would grant
    // something the user was never shown.
    session("thinking");
    pendingConfirmation("req-2");
    applyLiveActivityControl("approveRequest", "req-1");
    expect(handleConfirmationSubmit).not.toHaveBeenCalled();
  });

  test("a decision that names nothing is dropped", () => {
    // A shell older than the request id sends the action alone. There is no
    // safe way to guess what it meant.
    session("thinking");
    pendingConfirmation("req-1");
    applyLiveActivityControl("approveRequest");
    expect(handleConfirmationSubmit).not.toHaveBeenCalled();
  });

  test("a decision with nothing pending is dropped", () => {
    session("thinking");
    applyLiveActivityControl("approveRequest", "req-1");
    expect(handleConfirmationSubmit).not.toHaveBeenCalled();
  });

  test("the end control ends the session", () => {
    session("listening");
    applyLiveActivityControl("endSession");
    expect(controls.stop).toHaveBeenCalledTimes(1);
  });

  test("a press against a session that has already ended does nothing", () => {
    // The island outlives its session by however long ActivityKit takes to
    // dismiss it. An end landing in that window must not tear down whatever
    // the user started next.
    session("idle");
    pendingConfirmation("req-1");
    for (const action of [
      "muteMicrophone",
      "unmuteMicrophone",
      "muteAssistantAudio",
      "unmuteAssistantAudio",
      "endSession",
      "approveRequest",
    ] as const) {
      applyLiveActivityControl(action, "req-1");
    }
    expect(controls.stop).not.toHaveBeenCalled();
    expect(controls.setMuted).not.toHaveBeenCalled();
    expect(controls.setOutputMuted).not.toHaveBeenCalled();
    expect(handleConfirmationSubmit).not.toHaveBeenCalled();
  });

  test("a press against a failed session does nothing", () => {
    session("failed");
    applyLiveActivityControl("endSession");
    expect(controls.stop).not.toHaveBeenCalled();
  });
});
