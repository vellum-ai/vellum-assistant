import { afterEach, describe, expect, test } from "bun:test";

import {
  LS_VOICE_MODE_ACTIVATION_KEY,
  defaultVoiceModeActivator,
  isValidVoiceModeActivator,
  keyboardDefaultActivator,
  readVoiceModeActivator,
  writeVoiceModeActivator,
} from "@/utils/voice-mode-activation";
import { FN_PTT_ACTIVATOR } from "@/utils/ptt-activator";

afterEach(() => {
  localStorage.removeItem(LS_VOICE_MODE_ACTIVATION_KEY);
});

describe("isValidVoiceModeActivator", () => {
  test("rejects a bare modifier, which a toggle would fire on every abandoned chord", () => {
    expect(
      isValidVoiceModeActivator({
        kind: "modifierOnly",
        modifiers: ["control"],
      }),
    ).toBe(false);
  });

  test("accepts Fn, the one modifier nothing else claims", () => {
    expect(isValidVoiceModeActivator(FN_PTT_ACTIVATOR)).toBe(true);
  });

  test("accepts a chord and an explicit off", () => {
    expect(
      isValidVoiceModeActivator({
        kind: "key",
        label: "V",
        modifiers: ["command", "shift"],
      }),
    ).toBe(true);
    expect(isValidVoiceModeActivator({ kind: "off" })).toBe(true);
  });
});

describe("readVoiceModeActivator", () => {
  test("defaults to the keyboard chord with nothing stored", () => {
    expect(readVoiceModeActivator(false)).toEqual(keyboardDefaultActivator());
  });

  test("defaults to Fn where the host can see it", () => {
    expect(readVoiceModeActivator(true)).toEqual(FN_PTT_ACTIVATOR);
  });

  test("round-trips a stored chord", () => {
    const chord = {
      kind: "key" as const,
      label: "J",
      modifiers: ["control" as const, "shift" as const],
    };
    writeVoiceModeActivator(chord);
    expect(readVoiceModeActivator(false)).toEqual(chord);
  });

  test("keeps an explicit off", () => {
    writeVoiceModeActivator({ kind: "off" });
    expect(readVoiceModeActivator(false)).toEqual({ kind: "off" });
  });

  test("falls back to the default rather than off for an unusable stored value", () => {
    // A bare modifier can reach storage from the push-to-talk era or a hand
    // edit. Falling back to "off" would leave voice unreachable by keyboard
    // with the settings toggle still reading as on.
    localStorage.setItem(
      LS_VOICE_MODE_ACTIVATION_KEY,
      JSON.stringify({ kind: "modifierOnly", modifiers: ["control"] }),
    );
    expect(readVoiceModeActivator(false)).toEqual(keyboardDefaultActivator());
  });

  test("substitutes the chord for a stored Fn binding the host cannot see", () => {
    writeVoiceModeActivator(FN_PTT_ACTIVATOR);
    expect(readVoiceModeActivator(false)).toEqual(keyboardDefaultActivator());
  });
});

describe("defaultVoiceModeActivator", () => {
  test("the keyboard default is a chord, never a bare character", () => {
    const activator = keyboardDefaultActivator();
    expect(activator.kind).toBe("key");
    expect(
      activator.kind === "key" ? activator.modifiers.length : 0,
    ).toBeGreaterThan(0);
  });

  test("prefers Fn when the host offers it", () => {
    expect(defaultVoiceModeActivator(true)).toEqual(FN_PTT_ACTIVATOR);
  });
});
