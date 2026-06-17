/**
 * Tests for `prefersMacosNativeStt` — the forced-native gate must require
 * BOTH the persisted provider choice and a live helper dictation bridge. A
 * stale "macos-native" value in a renderer without the bridge (older
 * Electron preload, web/iOS) must not suppress the daemon STT paths, or
 * dictation would be left with no transcript source at all.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

let nativeDictationSupported = false;
mock.module("@/runtime/native-dictation-partials", () => ({
  isNativeDictationSupported: () => nativeDictationSupported,
}));

const { prefersMacosNativeStt } = await import("@/domains/chat/voice/stt-api");

const LS_STT_PROVIDER = "vellum:voice:sttProvider";

describe("prefersMacosNativeStt", () => {
  afterEach(() => {
    localStorage.clear();
    nativeDictationSupported = false;
  });

  test("false for the default provider even with the bridge available", () => {
    nativeDictationSupported = true;
    expect(prefersMacosNativeStt()).toBe(false);
  });

  test("true when chosen in settings and the helper bridge is available", () => {
    nativeDictationSupported = true;
    localStorage.setItem(LS_STT_PROVIDER, "macos-native");
    expect(prefersMacosNativeStt()).toBe(true);
  });

  test("a stale native choice without the bridge does not suppress daemon STT", () => {
    localStorage.setItem(LS_STT_PROVIDER, "macos-native");
    expect(prefersMacosNativeStt()).toBe(false);
  });
});
