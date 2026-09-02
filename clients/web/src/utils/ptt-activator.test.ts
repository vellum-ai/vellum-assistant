import { describe, expect, test } from "bun:test";

import { type PTTActivator, eventActivatesPTT } from "@/utils/ptt-activator";

/**
 * The matcher only reads `key` and the four modifier flags, so a plain
 * object stands in for the event. `key: undefined` mirrors the trusted
 * keydowns autofill and IME composition dispatch in production.
 */
function keydown(
  key: string | undefined,
  mods: Partial<
    Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">
  > = {},
): KeyboardEvent {
  return {
    key,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    metaKey: false,
    ...mods,
  } as KeyboardEvent;
}

const CTRL_SHIFT_V: PTTActivator = {
  kind: "key",
  label: "V",
  modifiers: ["control", "shift"],
};

const CTRL_ONLY: PTTActivator = {
  kind: "modifierOnly",
  modifiers: ["control"],
};

describe("eventActivatesPTT", () => {
  test("matches a key chord with its modifiers held", () => {
    expect(
      eventActivatesPTT(
        keydown("v", { ctrlKey: true, shiftKey: true }),
        CTRL_SHIFT_V,
      ),
    ).toBe(true);
  });

  test("rejects the key without its modifiers", () => {
    expect(eventActivatesPTT(keydown("v"), CTRL_SHIFT_V)).toBe(false);
  });

  test("matches a modifier-only binding on the modifier keydown", () => {
    expect(
      eventActivatesPTT(keydown("Control", { ctrlKey: true }), CTRL_ONLY),
    ).toBe(true);
  });

  test("rejects a keydown without a usable key instead of throwing", () => {
    expect(eventActivatesPTT(keydown(undefined), CTRL_SHIFT_V)).toBe(false);
    expect(
      eventActivatesPTT(
        keydown(undefined, { ctrlKey: true, shiftKey: true }),
        CTRL_SHIFT_V,
      ),
    ).toBe(false);
    expect(
      eventActivatesPTT(keydown(undefined, { ctrlKey: true }), CTRL_ONLY),
    ).toBe(false);
  });

  test("never matches when the activator is off", () => {
    expect(eventActivatesPTT(keydown("v"), { kind: "off" })).toBe(false);
  });
});
