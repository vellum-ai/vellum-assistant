import { beforeEach, describe, expect, mock, test } from "bun:test";

let isNative = true;
mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => {
    if (nativeThrows) throw new TypeError("isNativePlatform is not a function");
    return isNative;
  },
}));
let nativeThrows = false;

let flagValue: boolean | undefined = true;
mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    getState: () => {
      if (storeThrows) throw new Error("store not initialised");
      return { iosVoiceAudioSession: flagValue };
    },
  },
}));
let storeThrows = false;

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
  nativeThrows = false;
  storeThrows = false;
  flagValue = true;
  activateMock.mockClear();
  deactivateMock.mockClear();
  activateMock.mockImplementation(async () => {});
  deactivateMock.mockImplementation(async () => {});
});

describe("activateVoiceAudioSession", () => {
  test("calls into the native plugin when the flag is on", async () => {
    await activateVoiceAudioSession();

    expect(activateMock).toHaveBeenCalledTimes(1);
  });

  test("is a no-op when the flag is off — the kill switch", async () => {
    flagValue = false;

    await activateVoiceAudioSession();

    expect(activateMock).not.toHaveBeenCalled();
  });

  test("is a no-op when the flag is absent (fails closed)", async () => {
    flagValue = undefined;

    await activateVoiceAudioSession();

    expect(activateMock).not.toHaveBeenCalled();
  });

  test("is a no-op off the Capacitor shell (browser / Electron)", async () => {
    isNative = false;

    await activateVoiceAudioSession();

    expect(activateMock).not.toHaveBeenCalled();
  });

  test("swallows a native rejection", async () => {
    activateMock.mockImplementation(async () => {
      throw new Error("session busy");
    });

    await activateVoiceAudioSession();

    expect(activateMock).toHaveBeenCalledTimes(1);
  });

  // start() is documented never to throw, and use-live-voice.ts awaits its
  // promise with no catch — so a synchronous throw from the gate would take
  // the whole live-voice session down, not just echo cancellation.
  test("never throws when the platform check itself throws", async () => {
    nativeThrows = true;

    await activateVoiceAudioSession();

    expect(activateMock).not.toHaveBeenCalled();
  });

  test("never throws when the flag store is unavailable", async () => {
    storeThrows = true;

    await activateVoiceAudioSession();

    expect(activateMock).not.toHaveBeenCalled();
  });
});

describe("deactivateVoiceAudioSession", () => {
  test("calls into the native plugin on the Capacitor shell", async () => {
    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });

  // A session taken while the flag was on still has to be handed back if the
  // flag flips off mid-session, so deactivate is deliberately ungated.
  test("still releases the session when the flag is off", async () => {
    flagValue = false;

    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });

  test("is a no-op off the Capacitor shell", async () => {
    isNative = false;

    await deactivateVoiceAudioSession();

    expect(deactivateMock).not.toHaveBeenCalled();
  });

  test("swallows a native rejection so teardown always completes", async () => {
    deactivateMock.mockImplementation(async () => {
      throw new Error("deactivation failed");
    });

    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });

  test("never throws when the platform check itself throws", async () => {
    nativeThrows = true;

    await deactivateVoiceAudioSession();

    expect(deactivateMock).not.toHaveBeenCalled();
  });
});
