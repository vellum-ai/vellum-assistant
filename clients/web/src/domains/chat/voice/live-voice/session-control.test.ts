import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { makeControlsSpies } from "@/domains/chat/voice/live-voice/live-voice-fakes.test-helper";
import {
  takeLiveVoiceCameraLookRequest,
  useLiveVoiceStore,
} from "@/domains/chat/voice/live-voice/live-voice-store";
import {
  applyLiveVoiceSessionControl,
  liveVoiceSessionControls,
} from "@/domains/chat/voice/live-voice/session-control";
import { MIN_VERSION as SIGHT_STREAM_MIN_VERSION } from "@/lib/backwards-compat/use-supports-sight-stream";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";

const ASSISTANT_ID = "assistant-1";

/** An assistant that takes frames, as the looks need. */
function withSightStreamAssistant(): void {
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test", SIGHT_STREAM_MIN_VERSION, ASSISTANT_ID);
  useLiveVoiceStore.getState().setSessionContext(ASSISTANT_ID, null);
}

/** The macOS app's bridge, as far as the share needs it. */
function withShareBridge() {
  const setScreenShare = mock((_pick?: unknown) => {});
  (window as unknown as { vellum?: unknown }).vellum = {
    platform: "electron",
    companion: { setScreenShare },
  };
  return setScreenShare;
}

function withVisionMode(value: string): void {
  useClientFeatureFlagStore
    .getState()
    .setStringFlags({ visionMode: value }, null);
}

function withCamera(): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => new MediaStream() },
  });
}

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
  // An assistant too old for frames until a case says otherwise.
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test", "0.0.1", ASSISTANT_ID);
  useLiveVoiceStore.getState().reset();
  useLiveVoiceStore.getState().setState("listening");
});

afterEach(() => {
  // Ending cancels any timer a case left behind.
  applyLiveVoiceSessionControl({ action: "end" });
  useLiveVoiceStore.getState().setControls(null);
  delete (window as unknown as { vellum?: unknown }).vellum;
  withVisionMode("off");
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

  // The hands-free reconnect resets the store and restores the carried-over
  // mute in one synchronous block. The instant in between must not read as the
  // user unmuting, or a socket blip turns a timed mute into a permanent one.
  test("a timed mute outlives a reconnect", async () => {
    registerControls();

    applyLiveVoiceSessionControl({ action: "mute", durationMs: 20 });
    const store = useLiveVoiceStore.getState();
    store.reset({ sessionContinues: true });
    store.setState("connecting");
    store.setMuted(true);
    await sleep(40);

    expect(useLiveVoiceStore.getState().muted).toBe(false);
  });

  test("a session that ends cancels the timer", async () => {
    const controls = registerControls();

    applyLiveVoiceSessionControl({ action: "mute", durationMs: 10 });
    // How a session really ends: the reset that bumps the generation.
    useLiveVoiceStore.getState().reset();
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

describe("look controls", () => {
  test("a screen look shares the display under the pointer", () => {
    withSightStreamAssistant();
    const setScreenShare = withShareBridge();

    applyLiveVoiceSessionControl({ action: "look_screen" });

    expect(setScreenShare.mock.calls).toEqual([[{ kind: "pointerDisplay" }]]);
  });

  test("a screen look leaves a running share alone", () => {
    withSightStreamAssistant();
    const setScreenShare = withShareBridge();
    useLiveVoiceStore
      .getState()
      .setScreenShareTarget({ kind: "display", displayId: 1 } as never);

    applyLiveVoiceSessionControl({ action: "look_screen" });

    expect(setScreenShare).not.toHaveBeenCalled();
  });

  test("a spoken stop ends a running share and asks the room to close the camera", () => {
    withSightStreamAssistant();
    const setScreenShare = withShareBridge();
    useLiveVoiceStore
      .getState()
      .setScreenShareTarget({ kind: "display", displayId: 1 } as never);

    applyLiveVoiceSessionControl({ action: "look_stop" });

    // No pick is the stop, as the pill's Share sends it.
    expect(setScreenShare.mock.calls).toEqual([[]]);
    expect(takeLiveVoiceCameraLookRequest()).toBe("stop");
  });

  test("a spoken stop with no share running sends the host nothing", () => {
    withSightStreamAssistant();
    const setScreenShare = withShareBridge();

    applyLiveVoiceSessionControl({ action: "look_stop" });

    expect(setScreenShare).not.toHaveBeenCalled();
  });

  test("a camera look leaves one ask for the room, taken once", () => {
    applyLiveVoiceSessionControl({ action: "look_camera" });

    expect(takeLiveVoiceCameraLookRequest()).toBe("start");
    // A room that mounts later must not reopen the camera for the same ask.
    expect(takeLiveVoiceCameraLookRequest()).toBeNull();
  });
});

describe("liveVoiceSessionControls", () => {
  test("end and mute only, for an assistant that cannot take frames", () => {
    withShareBridge();
    withVisionMode("on");
    withCamera();

    expect(liveVoiceSessionControls(ASSISTANT_ID, "composer")).toEqual([
      "end",
      "mute",
    ]);
  });

  test("the macOS app's chat call can be shown the screen and the camera", () => {
    withSightStreamAssistant();
    withShareBridge();
    withVisionMode("on");
    withCamera();

    expect(liveVoiceSessionControls(ASSISTANT_ID, "composer")).toEqual([
      "end",
      "mute",
      "look_screen",
      "look_camera",
      "look_stop",
    ]);
  });

  test("a companion call has no room, so no camera", () => {
    withSightStreamAssistant();
    withShareBridge();
    withVisionMode("on");
    withCamera();

    expect(liveVoiceSessionControls(ASSISTANT_ID, "companion")).toEqual([
      "end",
      "mute",
      "look_screen",
      "look_stop",
    ]);
  });

  test("a browser gets the camera behind the vision flag", () => {
    withSightStreamAssistant();
    withCamera();

    expect(liveVoiceSessionControls(ASSISTANT_ID, "composer")).toEqual([
      "end",
      "mute",
    ]);
    withVisionMode("on");
    expect(liveVoiceSessionControls(ASSISTANT_ID, "composer")).toEqual([
      "end",
      "mute",
      "look_camera",
      "look_stop",
    ]);
  });
});
