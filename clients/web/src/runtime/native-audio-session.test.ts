/**
 * Tests for the `VoiceAudioSession` bridge.
 *
 * Both mobile shells may lag behind the web bundle. Exports fall back outside
 * native mobile and whenever the optional plugin is missing.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import type { PluginListenerHandle } from "@capacitor/core";

import type { VoiceAudioInterruptionEvent } from "@/runtime/native-audio-session";

let onNativeMobile = false;

mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => false,
  isNativeIOS: () => onNativeMobile,
  isNativeMobile: () => onNativeMobile,
}));

type Handler = (event: VoiceAudioInterruptionEvent) => void;

/** Handlers the module registered, so tests can emit native events. */
let handlers: Handler[] = [];

const activate = mock(async () => ({ activated: true }));
const deactivate = mock(async () => undefined);
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
    addListener,
  }),
}));

const {
  activateVoiceAudioSession,
  deactivateVoiceAudioSession,
  subscribeVoiceAudioInterruptions,
} = await import("@/runtime/native-audio-session");

beforeEach(() => {
  onNativeMobile = true;
  handlers = [];
  activate.mockClear();
  activate.mockImplementation(async () => ({ activated: true }));
  deactivate.mockClear();
  deactivate.mockImplementation(async () => undefined);
  remove.mockClear();
  addListener.mockClear();
  addListener.mockImplementation(defaultAddListener);
});

// ---------------------------------------------------------------------------
// Outside native mobile: browser and Electron paths
// ---------------------------------------------------------------------------

describe("outside a native mobile shell", () => {
  beforeEach(() => {
    onNativeMobile = false;
  });

  test("activate resolves false without touching the bridge", async () => {
    expect(await activateVoiceAudioSession()).toBe(false);
    expect(activate).not.toHaveBeenCalled();
  });

  test("deactivate resolves without touching the bridge", async () => {
    expect(await deactivateVoiceAudioSession()).toBeUndefined();
    expect(deactivate).not.toHaveBeenCalled();
  });

  test("subscribing registers nothing and unsubscribing is safe", () => {
    const unsubscribe = subscribeVoiceAudioInterruptions(() => undefined);
    expect(addListener).not.toHaveBeenCalled();
    expect(() => unsubscribe()).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Native mobile shell with the plugin present
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

  test("interruption events reach the handler until unsubscribed", async () => {
    const handler = mock((_event: VoiceAudioInterruptionEvent) => undefined);
    const unsubscribe = subscribeVoiceAudioInterruptions(handler);
    expect(addListener).toHaveBeenCalledWith(
      "voiceAudioInterruption",
      expect.any(Function),
    );

    handlers[0]?.({ type: "began", reason: "route-change" });
    expect(handler).toHaveBeenCalledWith({
      type: "began",
      reason: "route-change",
    });

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
// Native mobile shell without the plugin
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
