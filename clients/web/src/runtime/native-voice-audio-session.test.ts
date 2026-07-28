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

beforeEach(async () => {
  isNative = true;
  nativeThrows = false;
  storeThrows = false;
  flagValue = true;
  // `sessionHeld` is module-level: drop any hold the previous test left.
  await deactivateVoiceAudioSession();
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
  test("releases a session this module holds", async () => {
    await activateVoiceAudioSession();

    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });

  // A disabled flag must mean no native traffic at all, in either direction —
  // otherwise "off" still reaches the plugin on every capture teardown.
  test("makes no native call when nothing was ever activated", async () => {
    flagValue = false;
    await activateVoiceAudioSession();

    await deactivateVoiceAudioSession();

    expect(activateMock).not.toHaveBeenCalled();
    expect(deactivateMock).not.toHaveBeenCalled();
  });

  // The session outlives the flag: one taken while it was on still has to be
  // handed back if it flips off mid-session.
  test("still releases when the flag flips off mid-session", async () => {
    await activateVoiceAudioSession();
    flagValue = false;

    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });

  // A partial activation (category applied, activation failed) still leaves
  // state the native side has to restore.
  test("releases even when the activation failed", async () => {
    activateMock.mockImplementation(async () => {
      throw new Error("session busy");
    });
    await activateVoiceAudioSession();

    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });

  test("is idempotent — a second release makes no further call", async () => {
    await activateVoiceAudioSession();

    await deactivateVoiceAudioSession();
    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });

  test("swallows a native rejection so teardown always completes", async () => {
    await activateVoiceAudioSession();
    deactivateMock.mockImplementation(async () => {
      throw new Error("deactivation failed");
    });

    await deactivateVoiceAudioSession();

    expect(deactivateMock).toHaveBeenCalledTimes(1);
  });
});
