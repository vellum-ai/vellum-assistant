import { describe, expect, mock, test } from "bun:test";

let onNativeMobile = false;

mock.module("@/runtime/platform-detection", () => ({
  isNativeAndroid: () => false,
  isNativeIOS: () => onNativeMobile,
  isNativeMobile: () => onNativeMobile,
}));

import { callNativeVoice } from "@/runtime/native-voice";

describe("callNativeVoice", () => {
  test("returns the fallback off-native without invoking the bridge", async () => {
    onNativeMobile = false;
    const invoke = mock(async () => "native");

    expect(await callNativeVoice(invoke, "fallback")).toBe("fallback");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("returns the invoke result in a native mobile shell", async () => {
    onNativeMobile = true;
    const invoke = mock(async () => "native");

    expect(await callNativeVoice(invoke, "fallback")).toBe("native");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("returns the fallback when the bridge call rejects", async () => {
    onNativeMobile = true;
    // The shape of an older shell missing the plugin entirely.
    const invoke = mock(async () => {
      throw new Error("VoiceAudioSession does not have web implementation.");
    });

    expect(await callNativeVoice(invoke, "fallback")).toBe("fallback");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("never rethrows, for a synchronous throw or a non-Error rejection", async () => {
    onNativeMobile = true;

    expect(
      await callNativeVoice(() => {
        throw new Error("synchronous bridge failure");
      }, "fallback"),
    ).toBe("fallback");

    expect(
      await callNativeVoice(() => Promise.reject("not an Error"), "fallback"),
    ).toBe("fallback");
  });

  // A falsy fallback is the common case for these bridges ("did the native
  // side take over? no"), so guard against it being coerced away by a
  // `fallback ?? …` or truthiness check on either return path.
  test("returns a falsy fallback unchanged on both paths", async () => {
    const failing = async () => {
      throw new Error("bridge failure");
    };

    onNativeMobile = false;
    expect(await callNativeVoice(failing, false)).toBe(false);

    onNativeMobile = true;
    expect(await callNativeVoice(failing, false)).toBe(false);
  });
});
