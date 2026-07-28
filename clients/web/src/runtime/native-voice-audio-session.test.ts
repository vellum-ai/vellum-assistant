import { beforeEach, describe, expect, mock, test } from "bun:test";

let isNative = true;
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => isNative,
}));

const activateMock = mock(async () => {});
const deactivateMock = mock(async () => {});
mock.module("@capacitor/core", () => ({
  registerPlugin: () => ({
    activate: activateMock,
    deactivate: deactivateMock,
  }),
}));

const { activateVoiceAudioSession, deactivateVoiceAudioSession } = await import(
  "@/runtime/native-voice-audio-session"
);

beforeEach(() => {
  isNative = true;
  activateMock.mockClear();
  deactivateMock.mockClear();
  activateMock.mockImplementation(async () => {});
  deactivateMock.mockImplementation(async () => {});
});

describe("activateVoiceAudioSession", () => {
  test("calls into the native plugin on the Capacitor shell", async () => {
    await activateVoiceAudioSession();

    expect(activateMock).toHaveBeenCalledTimes(1);
  });

  test("is a no-op off the Capacitor shell (browser / Electron)", async () => {
    isNative = false;

    await activateVoiceAudioSession();

    expect(activateMock).not.toHaveBeenCalled();
  });

  test("swallows a native failure — an echoing call beats no call at all", async () => {
    activateMock.mockImplementation(async () => {
      throw new Error("session busy");
    });

    await activateVoiceAudioSession();

    expect(activateMock).toHaveBeenCalledTimes(1);
  });
});

describe("deactivateVoiceAudioSession", () => {
  test("calls into the native plugin on the Capacitor shell", async () => {
    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });

  test("is a no-op off the Capacitor shell", async () => {
    isNative = false;

    await deactivateVoiceAudioSession();

    expect(deactivateMock).not.toHaveBeenCalled();
  });

  test("swallows a native failure so teardown always completes", async () => {
    deactivateMock.mockImplementation(async () => {
      throw new Error("deactivation failed");
    });

    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });
});
