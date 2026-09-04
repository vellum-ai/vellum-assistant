import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { COMPANION_DICTATION_OFFER_MAX } from "@vellumai/ipc-contract";

let emitInput: (() => void) | null = null;
const setInputActivityWatch = mock(async (_enable: boolean) => true);
mock.module("@/runtime/input-activity", () => ({
  setInputActivityWatch,
  subscribeToInputActivity: (callback: () => void) => {
    emitInput = callback;
    return () => {
      emitInput = null;
    };
  },
}));

const {
  armDictationOfferWatch,
  clearDictationOffer,
  disarmDictationOfferWatch,
  setDictationOffer,
  useDictationOfferStore,
} = await import("@/domains/chat/voice/dictation-offer-store");

const WISPR = { bundleId: "com.electron.wispr-flow", name: "Wispr Flow" };

beforeEach(() => {
  setInputActivityWatch.mockClear();
});

afterEach(() => {
  clearDictationOffer();
  disarmDictationOfferWatch();
  emitInput = null;
});

describe("the dictation offer", () => {
  test("stands until taken down, and hands back what it held", () => {
    expect(
      setDictationOffer(WISPR, "Send me the files.", "com.example.editor"),
    ).toBe(true);
    expect(useDictationOfferStore.getState().offer).toMatchObject({
      text: "Send me the files.",
      frontApp: "com.example.editor",
    });

    const taken = clearDictationOffer();
    expect(taken?.app).toEqual(WISPR);
    expect(useDictationOfferStore.getState().offer).toBeNull();
    expect(clearDictationOffer()).toBeNull();
  });

  test("a new offer replaces the last one", () => {
    setDictationOffer(WISPR, "first", null);
    setDictationOffer(WISPR, "second", null);
    expect(useDictationOfferStore.getState().offer?.text).toBe("second");
  });

  /** What the companion shows is what "use" inserts: one bounded value. */
  test("holds the words bounded, the same as they are shown", () => {
    setDictationOffer(
      WISPR,
      "x".repeat(COMPANION_DICTATION_OFFER_MAX + 5),
      null,
    );
    expect(useDictationOfferStore.getState().offer?.text).toHaveLength(
      COMPANION_DICTATION_OFFER_MAX,
    );
  });
});

/**
 * "Use" replaces the last edit, so the offer is only honest while the other
 * app's paste still is one. Anything the user types or clicks ends that.
 */
describe("the watch on an offer", () => {
  test("a press while the offer stands takes it down", () => {
    armDictationOfferWatch();
    setDictationOffer(WISPR, "words", null);

    emitInput?.();

    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  /**
   * The cleanup pass sits between the hold ending and the offer appearing,
   * and takes seconds. A press in that gap has to count.
   */
  test("a press before the offer is made stops it being made", () => {
    armDictationOfferWatch();

    emitInput?.();

    expect(setDictationOffer(WISPR, "words", null)).toBe(false);
    expect(useDictationOfferStore.getState().offer).toBeNull();
  });

  test("watches the host only while it has something to guard", () => {
    armDictationOfferWatch();
    expect(setInputActivityWatch).toHaveBeenLastCalledWith(true);

    setDictationOffer(WISPR, "words", null);
    // Still watching: the offer it guards is now the one on screen.
    expect(setInputActivityWatch).toHaveBeenCalledTimes(1);

    clearDictationOffer();
    expect(setInputActivityWatch).toHaveBeenLastCalledWith(false);
  });

  test("arming again after a press starts a fresh verdict", () => {
    armDictationOfferWatch();
    emitInput?.();
    armDictationOfferWatch();

    expect(setDictationOffer(WISPR, "words", null)).toBe(true);
  });
});
