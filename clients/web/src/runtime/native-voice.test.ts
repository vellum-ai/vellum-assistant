import { describe, expect, mock, test } from "bun:test";

let onNativeIOS = false;

mock.module("@/runtime/platform-detection", () => ({
  isNativeIOS: () => onNativeIOS,
}));

import { callNativeVoice } from "@/runtime/native-voice";

// ---------------------------------------------------------------------------
// `callNativeVoice` is the skew-safe seam every native voice bridge call goes
// through. The iOS shell ships through App Store review while this bundle
// deploys continuously (`clients/ios/README.md` § "Web content delivery"), so
// an arbitrarily old shell can host this bundle and the plugin may simply not
// be there. The contract these tests pin: the helper never throws and never
// rejects, so a missing bridge degrades to a working voice session.
// ---------------------------------------------------------------------------

describe("callNativeVoice", () => {
  test("returns the fallback off-native without invoking the bridge", async () => {
    onNativeIOS = false;
    const invoke = mock(async () => "native");

    expect(await callNativeVoice(invoke, "fallback")).toBe("fallback");
    expect(invoke).not.toHaveBeenCalled();
  });

  test("returns the invoke result on native iOS", async () => {
    onNativeIOS = true;
    const invoke = mock(async () => "native");

    expect(await callNativeVoice(invoke, "fallback")).toBe("native");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("returns the fallback when the bridge call rejects", async () => {
    onNativeIOS = true;
    // The shape of an older shell missing the plugin entirely.
    const invoke = mock(async () => {
      throw new Error("VoiceAudioSession does not have web implementation.");
    });

    expect(await callNativeVoice(invoke, "fallback")).toBe("fallback");
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  test("never rethrows, for a synchronous throw or a non-Error rejection", async () => {
    onNativeIOS = true;

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

    onNativeIOS = false;
    expect(await callNativeVoice(failing, false)).toBe(false);

    onNativeIOS = true;
    expect(await callNativeVoice(failing, false)).toBe(false);
  });
});
