import { beforeEach, describe, expect, test } from "bun:test";

import { useVoicePrefsStore } from "@/stores/voice-prefs-store";

const VOICE_PREFS_STORE_KEY = "vellum:voice-prefs";

beforeEach(() => {
  localStorage.removeItem(VOICE_PREFS_STORE_KEY);
  useVoicePrefsStore.setState({
    showUserTranscript: false,
    showAssistantTranscript: false,
    firstRunSeen: false,
    flashMode: "off",
    showKeptFrame: false,
  });
});

describe("useVoicePrefsStore — voice-mode preferences", () => {
  test("defaults are all off", () => {
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);
  });

  test("setShowUserTranscript flips only the user-transcript field", () => {
    useVoicePrefsStore.getState().setShowUserTranscript(true);

    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(true);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);

    useVoicePrefsStore.getState().setShowUserTranscript(false);
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
  });

  test("setShowAssistantTranscript flips only the assistant-transcript field", () => {
    useVoicePrefsStore.getState().setShowAssistantTranscript(true);

    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(true);
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(false);
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(false);

    useVoicePrefsStore.getState().setShowAssistantTranscript(false);
    expect(useVoicePrefsStore.getState().showAssistantTranscript).toBe(false);
  });

  test("markFirstRunSeen sets the flag", () => {
    useVoicePrefsStore.getState().markFirstRunSeen();
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
  });

  test("markFirstRunSeen is idempotent and does not clobber later writes", () => {
    useVoicePrefsStore.getState().markFirstRunSeen();
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);

    // A subsequent unrelated write should survive a second markFirstRunSeen().
    useVoicePrefsStore.getState().setShowUserTranscript(true);
    useVoicePrefsStore.getState().markFirstRunSeen();

    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
    expect(useVoicePrefsStore.getState().showUserTranscript).toBe(true);
  });

  test("persists to the vellum:voice-prefs localStorage key", () => {
    useVoicePrefsStore.getState().setShowUserTranscript(true);
    useVoicePrefsStore.getState().setShowAssistantTranscript(true);
    useVoicePrefsStore.getState().markFirstRunSeen();
    useVoicePrefsStore.getState().setFlashMode("auto");

    const raw = localStorage.getItem(VOICE_PREFS_STORE_KEY);
    expect(raw).not.toBeNull();

    const persisted = JSON.parse(raw as string).state;
    expect(persisted.showUserTranscript).toBe(true);
    expect(persisted.showAssistantTranscript).toBe(true);
    expect(persisted.firstRunSeen).toBe(true);
    expect(persisted.flashMode).toBe("auto");
    expect(persisted.showKeptFrame).toBe(false);
  });
});

describe("useVoicePrefsStore: the kept-frame thumbnail", () => {
  test("ships off; the camera panel is where a call turns the signal on", () => {
    // The shipped value rather than the reset above, which is a test fixture.
    expect(useVoicePrefsStore.getInitialState().showKeptFrame).toBe(false);
  });

  test("setShowKeptFrame flips only that field, and survives a reload", () => {
    useVoicePrefsStore.getState().setShowKeptFrame(true);

    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(true);
    expect(useVoicePrefsStore.getState().flashMode).toBe("off");

    const persisted = JSON.parse(
      localStorage.getItem(VOICE_PREFS_STORE_KEY) as string,
    ).state;
    expect(persisted.showKeptFrame).toBe(true);

    useVoicePrefsStore.getState().setShowKeptFrame(false);
    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(false);
  });
});

/**
 * What a stored kept-frame value means. Only a payload at the current version
 * holds a choice; below it, the field reads false whether the payload carries
 * it or not.
 */
describe("useVoicePrefsStore: a stored kept-frame value", () => {
  /** Put a payload on the key at a given version, and read it back in. */
  async function rehydrateFrom(
    state: Record<string, unknown>,
    version?: number,
  ): Promise<void> {
    localStorage.setItem(
      VOICE_PREFS_STORE_KEY,
      JSON.stringify(version === undefined ? { state } : { state, version }),
    );
    await useVoicePrefsStore.persist.rehydrate();
  }

  test("an unversioned payload with no value for the field opens it off", async () => {
    await rehydrateFrom({ flashMode: "auto", firstRunSeen: true });

    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(false);
    // One field, and only that one: the rest of the payload is carried over.
    expect(useVoicePrefsStore.getState().flashMode).toBe("auto");
    expect(useVoicePrefsStore.getState().firstRunSeen).toBe(true);
  });

  test("a pre-v1 payload storing true opens it off, and is re-stamped", async () => {
    await rehydrateFrom({ flashMode: "auto", showKeptFrame: true }, 0);

    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(false);
    // Re-stamped on the way in, so the normalization runs once rather than on
    // every reload.
    const stored = JSON.parse(
      localStorage.getItem(VOICE_PREFS_STORE_KEY) as string,
    );
    expect(stored.version).toBe(1);
    expect(stored.state.showKeptFrame).toBe(false);
  });

  test("a value stored at the current version survives a reload", async () => {
    await rehydrateFrom({ showKeptFrame: true }, 1);

    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(true);
  });

  test("no stored payload at all opens the thumbnail off", async () => {
    localStorage.removeItem(VOICE_PREFS_STORE_KEY);
    await useVoicePrefsStore.persist.rehydrate();

    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(false);
  });
});

/**
 * A payload a later release wrote, read by this one. Zustand runs the migration
 * for every version that is not its own, so these arrive at the same door the
 * old ones do, and this build is not the one that gets to edit them.
 */
describe("useVoicePrefsStore: a payload from a newer build", () => {
  const FUTURE = {
    state: {
      flashMode: "auto",
      showKeptFrame: true,
      futureOnlyField: "set by a later release",
    },
    version: 2,
  };

  const stored = () =>
    JSON.parse(localStorage.getItem(VOICE_PREFS_STORE_KEY) as string);

  test("keeps the choice it holds, and the fields this build cannot name", async () => {
    localStorage.setItem(VOICE_PREFS_STORE_KEY, JSON.stringify(FUTURE));

    await useVoicePrefsStore.persist.rehydrate();

    // The kept-frame normalization is v0's business. Running it here would
    // throw away a choice made in a release that knows more than this one.
    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(true);
    expect(useVoicePrefsStore.getState().flashMode).toBe("auto");
    expect(
      (useVoicePrefsStore.getState() as unknown as Record<string, unknown>)
        .futureOnlyField,
    ).toBe("set by a later release");
  });

  test("survives the write zustand makes after every migration", async () => {
    // Zustand re-persists after ANY migration it runs, at its own version and
    // through its own partialize, and a migration cannot opt out of that. The
    // storage refuses that one write instead, so hydrating an older bundle
    // over a newer payload (a rollback, or a stale tab loading this module)
    // leaves the payload exactly as the newer build wrote it.
    const raw = JSON.stringify(FUTURE);
    localStorage.setItem(VOICE_PREFS_STORE_KEY, raw);

    await useVoicePrefsStore.persist.rehydrate();

    expect(localStorage.getItem(VOICE_PREFS_STORE_KEY)).toBe(raw);
  });

  test("a write this build makes while it is on disk is refused", async () => {
    // The cost of the rule, taken deliberately: this build's own edit lives
    // for the session and never reaches the key. A preference the user can set
    // again beats fields no one can recover.
    const raw = JSON.stringify(FUTURE);
    localStorage.setItem(VOICE_PREFS_STORE_KEY, raw);
    await useVoicePrefsStore.persist.rehydrate();

    useVoicePrefsStore.getState().setFlashMode("on");

    expect(useVoicePrefsStore.getState().flashMode).toBe("on");
    expect(localStorage.getItem(VOICE_PREFS_STORE_KEY)).toBe(raw);
  });

  test("a write at this build's own version is not blocked", async () => {
    localStorage.setItem(
      VOICE_PREFS_STORE_KEY,
      JSON.stringify({ state: { flashMode: "auto" }, version: 1 }),
    );
    await useVoicePrefsStore.persist.rehydrate();

    useVoicePrefsStore.getState().setFlashMode("on");

    expect(stored().state.flashMode).toBe("on");
    expect(stored().version).toBe(1);
  });

  test("a payload nothing can parse does not block the write", async () => {
    // Failing open. A key that cannot be read is not a newer schema, and
    // treating it as one would leave the key unwritable for good.
    localStorage.setItem(VOICE_PREFS_STORE_KEY, "{ not json");

    useVoicePrefsStore.getState().setFlashMode("on");

    expect(stored().state.flashMode).toBe("on");
    expect(stored().version).toBe(1);
  });

  test("a storage event carrying one is not read at all", async () => {
    // What ends the trade. Reading it would write the downgrade above, the
    // newer tab would hear that and upgrade it again, and the two would swap
    // writes for as long as both are open.
    useVoicePrefsStore.setState({ showKeptFrame: false, flashMode: "off" });
    localStorage.setItem(VOICE_PREFS_STORE_KEY, JSON.stringify(FUTURE));

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: VOICE_PREFS_STORE_KEY,
        newValue: JSON.stringify(FUTURE),
      }),
    );
    await Promise.resolve();

    expect(useVoicePrefsStore.getState().showKeptFrame).toBe(false);
    expect(useVoicePrefsStore.getState().flashMode).toBe("off");
    // Untouched on disk, so the newer tab still owns it.
    expect(stored().version).toBe(2);
    expect(stored().state.futureOnlyField).toBe("set by a later release");
  });

  test("a storage event at this build's own version is read normally", async () => {
    useVoicePrefsStore.setState({ flashMode: "off" });
    const current = { state: { flashMode: "auto" }, version: 1 };
    localStorage.setItem(VOICE_PREFS_STORE_KEY, JSON.stringify(current));

    window.dispatchEvent(
      new StorageEvent("storage", {
        key: VOICE_PREFS_STORE_KEY,
        newValue: JSON.stringify(current),
      }),
    );
    await Promise.resolve();

    expect(useVoicePrefsStore.getState().flashMode).toBe("auto");
  });
});

describe("useVoicePrefsStore: camera flash", () => {
  test("rests at off, so a call never opens with a flash the user did not ask for", () => {
    expect(useVoicePrefsStore.getState().flashMode).toBe("off");
  });

  test("setFlashMode records the choice verbatim", () => {
    useVoicePrefsStore.getState().setFlashMode("auto");
    expect(useVoicePrefsStore.getState().flashMode).toBe("auto");

    useVoicePrefsStore.getState().setFlashMode("on");
    expect(useVoicePrefsStore.getState().flashMode).toBe("on");

    useVoicePrefsStore.getState().setFlashMode("off");
    expect(useVoicePrefsStore.getState().flashMode).toBe("off");
  });

  test("holds the choice while a flashless camera is up", () => {
    // The device is never allowed to write here. A phone flipped to a front
    // camera with no flash hides the control; flipping back has to restore
    // what the user picked, not an "off" the hardware chose for them.
    useVoicePrefsStore.getState().setFlashMode("on");
    useVoicePrefsStore.getState().setShowUserTranscript(true);

    expect(useVoicePrefsStore.getState().flashMode).toBe("on");
  });
});
