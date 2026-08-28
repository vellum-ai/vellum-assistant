import { describe, expect, test } from "bun:test";

import { acceleratorToAriaKeyShortcuts } from "@vellumai/design-library";
import { ACCELERATOR_NAMED_KEYS } from "@vellumai/ipc-contract";

/**
 * The shell accepts a vocabulary of named keys; the renderer has to turn every
 * one of them into the value `aria-keyshortcuts` expects. Those two live in
 * different packages, and the design library deliberately depends on nothing
 * of ours, so nothing links them at the type level.
 *
 * This is the link. `clients/web` is the one package that can see both, so a
 * key added to the grammar without an announcement fails here rather than
 * reaching a screen reader as an unrecognised token. That matters because menu
 * and palette rows hide their drawn glyphs, which leaves this string as the
 * only announcement of a binding.
 */

/**
 * A UI Events `KeyboardEvent.key` value: a single character, a function key
 * (`F5`), or a name in upper camel case. Notably not an all-caps shout
 * (`INSERT`) or a lowercase passthrough (`insert`), which are the two shapes a
 * missing mapping produces.
 */
const UI_EVENTS_KEY =
  /^([^A-Za-z0-9]|[A-Z0-9]|[A-Z][0-9]+|[A-Z][a-z][A-Za-z]*[0-9]*)$/;

/** The key half of the announced value, dropping the modifier. */
function announcedKey(named: string): string {
  const announced = acceleratorToAriaKeyShortcuts(`CmdOrCtrl+${named}`, "mac");
  return announced.split("+").slice(1).join("+") || announced;
}

describe("every accelerator key the shell accepts can be announced", () => {
  test.each(ACCELERATOR_NAMED_KEYS.map((k) => [k]))(
    "%s announces as a UI Events key value",
    (named) => {
      expect(announcedKey(named)).toMatch(UI_EVENTS_KEY);
    },
  );

  test("the grammar accepts any case, so the announcement cannot depend on it", () => {
    for (const named of ACCELERATOR_NAMED_KEYS) {
      const canonical = announcedKey(named);
      expect(announcedKey(named.toLowerCase())).toBe(canonical);
      expect(announcedKey(named.toUpperCase())).toBe(canonical);
    }
  });

  test("the names Electron spells differently announce the UI Events value", () => {
    // These are the ones a passthrough gets wrong rather than merely ugly.
    expect(announcedKey("VolumeUp")).toBe("AudioVolumeUp");
    expect(announcedKey("VolumeDown")).toBe("AudioVolumeDown");
    expect(announcedKey("VolumeMute")).toBe("AudioVolumeMute");
    expect(announcedKey("MediaNextTrack")).toBe("MediaTrackNext");
    expect(announcedKey("MediaPreviousTrack")).toBe("MediaTrackPrevious");
  });
});
