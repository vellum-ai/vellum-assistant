import { afterEach, describe, expect, test } from "bun:test";

import {
  FN_VOICE_KEY,
  LS_VOICE_KEY,
  isFnVoiceKey,
  isHoldDictation,
  markHoldDictation,
  readVoiceKey,
  writeVoiceKey,
} from "@/utils/voice-key";

const LS_LEGACY_HOLD = "vellum:voice:holdToDictate";
const LS_LEGACY_ACTIVATION = "vellum:voice:voiceModeActivation";

afterEach(() => {
  markHoldDictation(false);
  localStorage.removeItem(LS_VOICE_KEY);
  localStorage.removeItem(LS_LEGACY_HOLD);
  localStorage.removeItem(LS_LEGACY_ACTIVATION);
});

describe("the voice key", () => {
  test("is Fn out of the box", () => {
    expect(readVoiceKey()).toEqual(FN_VOICE_KEY);
    expect(isFnVoiceKey(readVoiceKey())).toBe(true);
  });

  test("round-trips a custom set and an off", () => {
    writeVoiceKey({ kind: "modifierOnly", modifiers: ["control", "option"] });
    expect(readVoiceKey()).toEqual({
      kind: "modifierOnly",
      modifiers: ["control", "option"],
    });
    expect(isFnVoiceKey(readVoiceKey())).toBe(false);

    writeVoiceKey({ kind: "off" });
    expect(readVoiceKey()).toEqual({ kind: "off" });
  });

  test("reads a hand edit as nothing stored", () => {
    localStorage.setItem(
      LS_VOICE_KEY,
      '{"kind":"modifierOnly","modifiers":[]}',
    );
    expect(readVoiceKey()).toEqual(FN_VOICE_KEY);
    localStorage.setItem(LS_VOICE_KEY, "not json");
    expect(readVoiceKey()).toEqual(FN_VOICE_KEY);
  });

  /**
   * The key replaces two settings, and an upgrade keeps what the user had: a
   * hold on Ctrl+Option stays there, a shortcut turned off stays off, and
   * everyone else lands on the default.
   */
  describe("before it was stored", () => {
    test("keeps a hold that was on Ctrl+Option", () => {
      localStorage.setItem(LS_LEGACY_HOLD, "true");
      localStorage.setItem(
        LS_LEGACY_ACTIVATION,
        JSON.stringify({ kind: "off" }),
      );
      expect(readVoiceKey()).toEqual({
        kind: "modifierOnly",
        modifiers: ["control", "option"],
      });
    });

    test("keeps a hold that was switched off, off", () => {
      localStorage.setItem(LS_LEGACY_HOLD, "false");
      expect(readVoiceKey()).toEqual({ kind: "off" });
    });

    test("a chosen Fn tap outranks a hold that was switched off", () => {
      localStorage.setItem(LS_LEGACY_HOLD, "false");
      localStorage.setItem(
        LS_LEGACY_ACTIVATION,
        JSON.stringify({ kind: "modifierOnly", modifiers: ["function"] }),
      );
      expect(readVoiceKey()).toEqual(FN_VOICE_KEY);
    });

    test("keeps a shortcut that was turned off", () => {
      localStorage.setItem(
        LS_LEGACY_ACTIVATION,
        JSON.stringify({ kind: "off" }),
      );
      expect(readVoiceKey()).toEqual({ kind: "off" });
    });

    test("lands a chosen Fn tap on Fn", () => {
      localStorage.setItem(
        LS_LEGACY_ACTIVATION,
        JSON.stringify({ kind: "modifierOnly", modifiers: ["function"] }),
      );
      expect(readVoiceKey()).toEqual(FN_VOICE_KEY);
    });

    test("is read through, so a choice made now wins", () => {
      localStorage.setItem(
        LS_LEGACY_ACTIVATION,
        JSON.stringify({ kind: "off" }),
      );
      writeVoiceKey(FN_VOICE_KEY);
      expect(readVoiceKey()).toEqual(FN_VOICE_KEY);
    });
  });
});

describe("the hold dictation marker", () => {
  test("is off until a hold marks it", () => {
    expect(isHoldDictation()).toBe(false);

    markHoldDictation(true);
    expect(isHoldDictation()).toBe(true);
  });

  /**
   * The recording is started through an imperative handle on whichever button
   * owns dictation, so the marker is how the session learns what it was begun
   * for. It is read once at the start; clearing it later must not reach back
   * into a session already running.
   */
  test("clears when the hold ends", () => {
    markHoldDictation(true);
    markHoldDictation(false);

    expect(isHoldDictation()).toBe(false);
  });
});
