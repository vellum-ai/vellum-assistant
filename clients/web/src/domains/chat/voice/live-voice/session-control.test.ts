import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeControlsSpies } from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";
import { useLiveVoiceStore } from "@/domains/chat/voice/live-voice/live-voice-store";
import { applyLiveVoiceSessionControl } from "@/domains/chat/voice/live-voice/session-control";

/** Controls whose mute writes the store, as the real controller does. */
function registerControls() {
  const controls = {
    ...makeControlsSpies(),
    setMuted: mock((muted: boolean) => {
      useLiveVoiceStore.getState().setMuted(muted);
    }),
  };
  useLiveVoiceStore.getState().setControls(controls);
  return controls;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

beforeEach(() => {
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setState("listening");
});

afterEach(() => {
  // Ending cancels any timer a case left behind.
  applyLiveVoiceSessionControl({ action: "end" });
  useLiveVoiceStore.getState().setControls(null);
});

describe("applyLiveVoiceSessionControl", () => {
  test("end stops the session through the shared controls", () => {
    const controls = registerControls();

    applyLiveVoiceSessionControl({ action: "end" });

    expect(controls.stop).toHaveBeenCalledTimes(1);
  });

  test("an untimed mute stays muted", async () => {
    const controls = registerControls();

    applyLiveVoiceSessionControl({ action: "mute" });
    await sleep(20);

    expect(controls.setMuted.mock.calls).toEqual([[true]]);
    expect(useLiveVoiceStore.getState().muted).toBe(true);
  });

  test("a timed mute unmutes when it elapses", async () => {
    registerControls();

    applyLiveVoiceSessionControl({ action: "mute", durationMs: 10 });
    expect(useLiveVoiceStore.getState().muted).toBe(true);
    await sleep(30);

    expect(useLiveVoiceStore.getState().muted).toBe(false);
  });

  // The user took the mic back and muted again themselves; the old timer
  // must not unmute a mute it never set.
  test("a manual unmute cancels the timer", async () => {
    const controls = registerControls();

    applyLiveVoiceSessionControl({ action: "mute", durationMs: 20 });
    controls.setMuted(false);
    controls.setMuted(true);
    await sleep(40);

    expect(useLiveVoiceStore.getState().muted).toBe(true);
  });

  test("a session that ends cancels the timer", async () => {
    const controls = registerControls();

    applyLiveVoiceSessionControl({ action: "mute", durationMs: 10 });
    useLiveVoiceStore.getState().setState("idle");
    await sleep(30);

    expect(controls.setMuted.mock.calls).toEqual([[true]]);
  });

  test.each([[-5], [Number.NaN], [Number.POSITIVE_INFINITY]])(
    "a malformed duration %p mutes without a timer",
    async (durationMs) => {
      registerControls();

      applyLiveVoiceSessionControl({ action: "mute", durationMs });
      await sleep(20);

      expect(useLiveVoiceStore.getState().muted).toBe(true);
    },
  );
});
