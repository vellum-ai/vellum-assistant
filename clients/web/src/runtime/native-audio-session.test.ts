/**
 * Tests for the `VoiceAudioSession` bridge.
 *
 * The contract under test is skew-safety: the iOS shell ships through App Store
 * review while this bundle deploys continuously, so an arbitrarily old shell
 * can host it with no such plugin compiled in. Every exported function must
 * therefore resolve — never reject, never hang — whether the plugin answers,
 * rejects, or does not exist, and must not touch the bridge at all off iOS.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PluginListenerHandle } from "@capacitor/core";

import type { VoiceAudioInterruptionEvent } from "@/runtime/native-audio-session";

let onNativeIOS = false;

mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => onNativeIOS,
}));

type Handler = (event: VoiceAudioInterruptionEvent) => void;

/** Handlers the module registered, so tests can emit native events. */
let handlers: Handler[] = [];

const activate = mock(async () => ({ activated: true }));
const deactivate = mock(async () => undefined);
const defaultDescribe = async () => ({
  category: "AVAudioSessionCategoryPlayAndRecord",
  mode: "AVAudioSessionModeVoiceChat",
  outputs: ["Speaker"],
});
const describeSession = mock(defaultDescribe);
const remove = mock(async () => undefined);

// Registration is async on the real bridge, so the handle only lands a
// microtask later — the window the unsubscribe race lives in.
const defaultAddListener = (
  _event: string,
  handler: Handler,
): Promise<PluginListenerHandle> => {
  handlers.push(handler);
  return Promise.resolve({ remove });
};
const addListener = mock(defaultAddListener);

mock.module("@capacitor/core", () => ({
  registerPlugin: () => ({
    activate,
    deactivate,
    describe: describeSession,
    addListener,
  }),
}));

const {
  activateVoiceAudioSession,
  deactivateVoiceAudioSession,
  describeVoiceAudioSession,
  subscribeVoiceAudioInterruptions,
} = await import("@/runtime/native-audio-session");

beforeEach(() => {
  onNativeIOS = true;
  handlers = [];
  activate.mockClear();
  activate.mockImplementation(async () => ({ activated: true }));
  deactivate.mockClear();
  deactivate.mockImplementation(async () => undefined);
  describeSession.mockClear();
  describeSession.mockImplementation(defaultDescribe);
  remove.mockClear();
  addListener.mockClear();
  addListener.mockImplementation(defaultAddListener);
});

// ---------------------------------------------------------------------------
// Off-native — the browser and Electron paths
// ---------------------------------------------------------------------------

describe("off the iOS shell", () => {
  beforeEach(() => {
    onNativeIOS = false;
  });

  test("activate resolves false without touching the bridge", async () => {
    expect(await activateVoiceAudioSession()).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  test("deactivate resolves without touching the bridge", async () => {
    expect(await deactivateVoiceAudioSession()).toBeUndefined();
    expect(deactivate).not.toHaveBeenCalled();
  });

  test("describe resolves null without touching the bridge", async () => {
    expect(await describeVoiceAudioSession()).toBeNull();
    expect(describeSession).not.toHaveBeenCalled();
  });

  test("subscribing registers nothing and unsubscribing is safe", () => {
    const unsubscribe = subscribeVoiceAudioInterruptions(() => undefined);
    expect(addListener).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// On the iOS shell, plugin present
// ---------------------------------------------------------------------------

describe("with the plugin present", () => {
  test("activate reports whether the native side took the session", async () => {
    expect(await activateVoiceAudioSession()).toBe(true);
    expect(activate).toHaveBeenCalledTimes(1);

    activate.mockImplementation(async () => ({ activated: false }));
    expect(await activateVoiceAudioSession()).toBe(false);
  });

  test("deactivate calls through", async () => {
    await deactivateVoiceAudioSession();
    expect(deactivate).toHaveBeenCalledTimes(1);
  });

  test("describe reads the session back without configuring it", async () => {
    const description = await describeVoiceAudioSession();

    expect(description).toMatchObject({
      category: "AVAudioSessionCategoryPlayAndRecord",
      mode: "AVAudioSessionModeVoiceChat",
      outputs: ["Speaker"],
    });
    // Reading the category back is the only sanctioned way to test a belief
    // about the shared session: activating one underneath WebKit's live
    // capture unit has broken live voice on a handset twice.
    expect(activate).not.toHaveBeenCalled();
    expect(deactivate).not.toHaveBeenCalled();
  });

  test("describe resolves null when an older shell has no such method", async () => {
    describeSession.mockImplementation(async () => {
      throw new Error("not implemented");
    });

    expect(await describeVoiceAudioSession()).toBeNull();
  });

  test("interruption events reach the handler until unsubscribed", async () => {
    const handler = mock((_event: VoiceAudioInterruptionEvent) => undefined);
    const unsubscribe = subscribeVoiceAudioInterruptions(handler);
    expect(addListener).toHaveBeenCalledWith(
      "voiceAudioInterruption",
      expect.any(Function),
    );

    handlers[0]?.({ type: "began" });
    expect(handler).toHaveBeenCalledWith({ type: "began" });

    // Let the registration settle so the handle is held, then release it.
    await Promise.resolve();
    unsubscribe();
    expect(remove).toHaveBeenCalledTimes(1);
  });

  test("unsubscribing before registration settles still removes the listener", async () => {
    const unsubscribe = subscribeVoiceAudioInterruptions(() => undefined);
    // Unsubscribe while `addListener` is still in flight — the pending
    // registration must be torn down on arrival, not leaked.
    unsubscribe();
    await Promise.resolve();
    await Promise.resolve();
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// On the iOS shell, older shell without the plugin — the skew case
// ---------------------------------------------------------------------------

describe("with an older shell that has no plugin", () => {
  // What `registerPlugin` produces for a plugin the shell never registered:
  // every method rejects rather than being absent.
  const notImplemented = async (): Promise<never> => {
    throw new Error("VoiceAudioSession does not have web implementation.");
  };

  beforeEach(() => {
    activate.mockImplementation(notImplemented);
    deactivate.mockImplementation(notImplemented);
  });

  test("activate resolves false instead of rejecting", async () => {
    expect(await activateVoiceAudioSession()).toBe(false);
  });

  test("deactivate resolves instead of rejecting", async () => {
    expect(await deactivateVoiceAudioSession()).toBeUndefined();
  });

  test("a rejecting addListener never surfaces to the caller", async () => {
    addListener.mockImplementation(() =>
      Promise.reject(new Error("no plugin")),
    );

    let unsubscribe: (() => void) | undefined;
    expect(() => {
      unsubscribe = subscribeVoiceAudioInterruptions(() => undefined);
    }).not.toThrow();
    await Promise.resolve();
    expect(() => unsubscribe?.()).not.toThrow();
    expect(remove).not.toHaveBeenCalled();
  });
});
