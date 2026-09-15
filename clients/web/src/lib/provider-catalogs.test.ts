import { describe, expect, it } from "bun:test";

import {
  MACOS_NATIVE_STT_PROVIDER_ID,
  sttProvidersForHostOS,
} from "./provider-catalogs";

const WINDOWS_COPY = {
  displayName: "Windows Native Dictation",
  subtitle: "Windows on-device recognition.",
  setupWarning: "Turn on Windows speech recognition.",
};

function nativeEntry(hostOS: Parameters<typeof sttProvidersForHostOS>[0]) {
  return sttProvidersForHostOS(hostOS, WINDOWS_COPY).find(
    (provider) => provider.id === MACOS_NATIVE_STT_PROVIDER_ID,
  );
}

describe("sttProvidersForHostOS", () => {
  it("keeps the macOS native entry on macOS and off Electron", () => {
    expect(nativeEntry("macos")?.displayName).toBe("macOS Native Dictation");
    expect(nativeEntry(null)?.displayName).toBe("macOS Native Dictation");
  });

  it("rewrites the native entry with Windows copy on a Windows host", () => {
    expect(nativeEntry("windows")).toMatchObject({
      ...WINDOWS_COPY,
      requiresNativeDictation: true,
    });
  });

  it("offers no native entry on Linux, which has no on-device recognizer", () => {
    expect(nativeEntry("linux")).toBeUndefined();
    // The keyed providers are unaffected.
    expect(
      sttProvidersForHostOS("linux", WINDOWS_COPY).map(({ id }) => id),
    ).toEqual(["vellum", "deepgram", "openai"]);
  });
});
