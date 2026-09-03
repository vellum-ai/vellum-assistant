import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let onElectron = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => onElectron,
}));

const {
  LS_VOICE_MODE_ACTIVATION_KEY,
  defaultVoiceModeActivator,
  isValidVoiceModeActivator,
  keyboardDefaultActivator,
  readVoiceModeActivator,
  writeVoiceModeActivator,
} = await import("@/utils/voice-mode-activation");

beforeEach(() => {
  onElectron = false;
});

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
    expect(readVoiceModeActivator()).toEqual(keyboardDefaultActivator());
  });

  test("binds nothing on the desktop app, where the DOM chord is never bound", () => {
    onElectron = true;
    expect(readVoiceModeActivator()).toEqual({ kind: "off" });
  });

  test("round-trips a stored chord", () => {
    const chord = {
      kind: "key" as const,
      label: "J",
      modifiers: ["control" as const, "shift" as const],
    };
    writeVoiceModeActivator(chord);
    expect(readVoiceModeActivator()).toEqual(chord);
  });

  test("keeps an explicit off", () => {
    writeVoiceModeActivator({ kind: "off" });
    expect(readVoiceModeActivator()).toEqual({ kind: "off" });
  });

  test("falls back to the host default for an unusable stored value", () => {
    // A bare modifier can reach storage from the push-to-talk era or a hand
    // edit. Falling back to "off" would leave voice unreachable by keyboard
    // with the settings toggle still reading as on.
    localStorage.setItem(
      LS_VOICE_MODE_ACTIVATION_KEY,
      JSON.stringify({ kind: "modifierOnly", modifiers: ["control"] }),
    );
    expect(readVoiceModeActivator()).toEqual(keyboardDefaultActivator());
  });

  /** Fn was this setting's answer before it became the voice key. */
  test("reads a stored Fn binding as nothing usable", () => {
    localStorage.setItem(
      LS_VOICE_MODE_ACTIVATION_KEY,
      JSON.stringify({ kind: "modifierOnly", modifiers: ["function"] }),
    );
    expect(readVoiceModeActivator()).toEqual(keyboardDefaultActivator());
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

  test("is off on the desktop app", () => {
    onElectron = true;
    expect(defaultVoiceModeActivator()).toEqual({ kind: "off" });
  });
});
