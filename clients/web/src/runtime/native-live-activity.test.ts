/**
 * Tests for the `VoiceLiveActivity` bridge.
 *
 * The contract under test is skew-safety: mobile shells ship through store
 * review while this bundle deploys continuously, so an arbitrarily old shell
 * can host it with no such plugin compiled in. Every exported function must
 * therefore resolve without rejecting or hanging whether the plugin answers,
 * rejects, or does not exist, and must not touch the bridge off native mobile.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  VoiceLiveActivityContent,
  VoiceLiveActivityStart,
} from "@/runtime/native-live-activity";

let onNativeAndroid = false;
let onNativeIOS = false;

mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => onNativeAndroid,
  isNativeIOS: () => onNativeIOS,
  isNativeMobile: () => onNativeAndroid || onNativeIOS,
}));

const start = mock(async () => ({ started: true }));
const update = mock(async () => undefined);
const end = mock(async () => undefined);
const addListener = mock(async () => ({
  remove: async () => undefined,
}));

mock.module("@capacitor/core", () => ({
  registerPlugin: () => ({ start, update, end, addListener }),
}));

const {
  startVoiceLiveActivity,
  updateVoiceLiveActivity,
  endVoiceLiveActivity,
  subscribeVoiceLiveActivityPushToken,
  subscribeVoiceLiveActivityControl,
} = await import("@/runtime/native-live-activity");

const content: VoiceLiveActivityContent = {
  phase: "listening",
  label: "Listening…",
  accentHex: "#7C3AED",
  muted: false,
  outputMuted: false,
  detail: "",
  approvalRequestId: "",
};
const startOptions: VoiceLiveActivityStart = {
  ...content,
  phase: "connecting",
  label: "Connecting…",
  assistantName: "Vellum",
};

beforeEach(() => {
  onNativeAndroid = false;
  onNativeIOS = true;
  start.mockClear();
  start.mockImplementation(async () => ({ started: true }));
  update.mockClear();
  update.mockImplementation(async () => undefined);
  end.mockClear();
  end.mockImplementation(async () => undefined);
  addListener.mockClear();
});

// ---------------------------------------------------------------------------
// Off-native — the browser and Electron paths
// ---------------------------------------------------------------------------

describe("outside a native mobile shell", () => {
  beforeEach(() => {
    onNativeIOS = false;
  });

  test("start resolves false without touching the bridge", async () => {
    expect(await startVoiceLiveActivity(startOptions)).toBe(false);
    expect(start).not.toHaveBeenCalled();
  });

  test("update resolves without touching the bridge", async () => {
    expect(await updateVoiceLiveActivity(content)).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
  });

  test("end resolves without touching the bridge", async () => {
    expect(await endVoiceLiveActivity()).toBeUndefined();
    expect(end).not.toHaveBeenCalled();
  });
});

test("Android dispatches status calls but not ActivityKit push tokens", async () => {
  onNativeAndroid = true;
  onNativeIOS = false;

  expect(await startVoiceLiveActivity(startOptions)).toBe(true);
  expect(start).toHaveBeenCalledWith(startOptions);
  await updateVoiceLiveActivity(content);
  expect(update).toHaveBeenCalledWith(content);
  await endVoiceLiveActivity();
  expect(end).toHaveBeenCalledTimes(1);
  const unsubscribe = subscribeVoiceLiveActivityPushToken(() => undefined);
  const unsubscribeControls = subscribeVoiceLiveActivityControl(() => undefined);
  expect(addListener).not.toHaveBeenCalled();
  unsubscribe();
  unsubscribeControls();
});

// ---------------------------------------------------------------------------
// On the iOS shell, plugin present
// ---------------------------------------------------------------------------

describe("with the plugin present", () => {
  test("start forwards the payload and reports whether one is running", async () => {
    expect(await startVoiceLiveActivity(startOptions)).toBe(true);
    expect(start).toHaveBeenCalledWith(startOptions);

    // Live Activities switched off for the app in iOS Settings: a `false`, not
    // an error, and the only availability answer a caller ever needs.
    start.mockImplementation(async () => ({ started: false }));
    expect(await startVoiceLiveActivity(startOptions)).toBe(false);
  });

  test("update and end call through", async () => {
    await updateVoiceLiveActivity(content);
    expect(update).toHaveBeenCalledWith(content);

    await endVoiceLiveActivity();
    expect(end).toHaveBeenCalledTimes(1);
  });

  test("a payload missing the expected shape reads as not running", async () => {
    // A shell that answers `{}` must not read as success.
    start.mockImplementation(async () => ({}) as { started: boolean });
    expect(await startVoiceLiveActivity(startOptions)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// On the iOS shell, older shell without the plugin — the skew case
// ---------------------------------------------------------------------------

describe("with an older shell that has no plugin", () => {
  // What `registerPlugin` produces for a plugin the shell never registered:
  // every method rejects rather than being absent.
  const notImplemented = async (): Promise<never> => {
    throw new Error("VoiceLiveActivity does not have web implementation.");
  };

  beforeEach(() => {
    start.mockImplementation(notImplemented);
    update.mockImplementation(notImplemented);
    end.mockImplementation(notImplemented);
  });

  test("every export swallows the rejection and returns its fallback", async () => {
    expect(await startVoiceLiveActivity(startOptions)).toBe(false);
    expect(await updateVoiceLiveActivity(content)).toBeUndefined();
    expect(await endVoiceLiveActivity()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Island buttons — the one inbound path that acts on the session
// ---------------------------------------------------------------------------

describe("control events", () => {
  test("subscribes on the plugin's own event name", () => {
    const handler = mock((_event: { action: string }) => undefined);
    const unsubscribe = subscribeVoiceLiveActivityControl(handler);
    expect(addListener).toHaveBeenCalledWith(
      "liveActivityControl",
      expect.any(Function),
    );
    unsubscribe();
  });

  test("a shell too old to send them is silent, not broken", () => {
    // `addListener` is one of the few names the Capacitor plugin Proxy does
    // not trap into a fabricated native method, so this is a subscription that
    // simply never fires — the correct degradation for a shell whose island
    // has no buttons on it.
    addListener.mockImplementation(async () => {
      throw new Error("VoiceLiveActivity does not have web implementation.");
    });
    const unsubscribe = subscribeVoiceLiveActivityControl(() => undefined);
    expect(unsubscribe).toBeInstanceOf(Function);
    unsubscribe();
  });
});

// ---------------------------------------------------------------------------
// Wire contract with the Swift side
// ---------------------------------------------------------------------------

describe("phase typing", () => {
  // `VoiceSessionAttributes.ContentState.Phase` has neither case: a Live
  // Activity exists only for a running session. The assertions are the
  // `@ts-expect-error`s themselves — `bun run typecheck` fails if the union
  // ever admits either value.
  test("rejects idle at compile time", () => {
    // @ts-expect-error — "idle" is not a Live Activity phase.
    const idle: VoiceLiveActivityContent = { ...content, phase: "idle" };
    expect(idle).toBeDefined();
  });

  test("rejects failed at compile time", () => {
    // The mirror ends the activity on a failure rather than pushing a phase
    // for it, so `failed` is unreachable and must not typecheck either.
    // @ts-expect-error — "failed" is not a Live Activity phase.
    const failed: VoiceLiveActivityContent = { ...content, phase: "failed" };
    expect(failed).toBeDefined();
  });
});
