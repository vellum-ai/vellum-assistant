/**
 * Tests for `applyLiveActivityControl` — what an iOS Live Activity button does
 * to the running session.
 *
 * The subject is the resolution step, not the bridge: everything interesting
 * about these controls is that they are *toggles* resolved against live store
 * state rather than absolute commands composed from what the island happened to
 * be rendering. The island can be seconds stale, and on the APNs path is
 * composed without `outputMuted` at all, so "what did the button send" is the
 * wrong question and "what did the session do about it" is the right one.
 *
 * The bridge subscription itself (off-iOS and older-shell no-ops) is pinned by
 * `runtime/native-live-activity.test.ts`.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { applyLiveActivityControl } from "@/domains/chat/voice/live-voice/use-live-activity-controls";
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

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  for (const control of Object.values(controls)) {
    control.mockClear();
  }
});

describe("applyLiveActivityControl", () => {
  test("the mic button mutes an unmuted session", () => {
    session("listening");
    applyLiveActivityControl("toggleMicrophone");
    expect(controls.setMuted).toHaveBeenCalledWith(true);
  });

  test("the mic button unmutes a muted session — it is one toggle, not two commands", () => {
    // The island renders "muted" from content that may be seconds old. The
    // toggle is resolved here, against the store, so the button is right even
    // when what the user was looking at was not.
    session("listening", { muted: true });
    applyLiveActivityControl("toggleMicrophone");
    expect(controls.setMuted).toHaveBeenCalledWith(false);
  });

  test("the speaker button toggles the assistant's audio", () => {
    session("speaking", { outputMuted: true });
    applyLiveActivityControl("toggleAssistantAudio");
    expect(controls.setOutputMuted).toHaveBeenCalledWith(false);
  });

  test("the speaker button reads live state, not the island's copy of it", () => {
    // The APNs path composes content with no `outputMuted` in it at all, so an
    // island driven by the server shows the assistant as audible whatever the
    // session thinks. The press must still land on the right side of it.
    session("speaking", { outputMuted: true });
    applyLiveActivityControl("toggleAssistantAudio");
    expect(controls.setOutputMuted).toHaveBeenCalledWith(false);
    expect(controls.setOutputMuted).not.toHaveBeenCalledWith(true);
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
    for (const action of [
      "toggleMicrophone",
      "toggleAssistantAudio",
      "endSession",
    ] as const) {
      applyLiveActivityControl(action);
    }
    expect(controls.stop).not.toHaveBeenCalled();
    expect(controls.setMuted).not.toHaveBeenCalled();
    expect(controls.setOutputMuted).not.toHaveBeenCalled();
  });

  test("a press against a failed session does nothing", () => {
    session("failed");
    applyLiveActivityControl("endSession");
    expect(controls.stop).not.toHaveBeenCalled();
  });
});
