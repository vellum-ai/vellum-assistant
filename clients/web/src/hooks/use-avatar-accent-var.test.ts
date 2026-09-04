import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  AVATAR_ACCENT_CSS_VAR,
  AVATAR_ACCENT_FILL_CSS_VAR,
  AVATAR_ACCENT_INK_CSS_VAR,
  avatarAccentVars,
  getPublishedAvatarAccentHex,
  useAvatarAccentVar,
} from "./use-avatar-accent-var";

const ORANGE = "#E9642F";
/** The palette's light one, where white text is about 1.6:1. */
const YELLOW = "#E9C91A";
/** An uploaded image's colour dark enough to take white. */
const NAVY = "#20336B";
/** A grey in the band where neither ink clears the small-text floor. */
const MID_GREY = "#7C7C7C";

const readVar = (name: string) =>
  document.documentElement.style.getPropertyValue(name);

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(AVATAR_ACCENT_CSS_VAR);
  document.documentElement.style.removeProperty(AVATAR_ACCENT_FILL_CSS_VAR);
  document.documentElement.style.removeProperty(AVATAR_ACCENT_INK_CSS_VAR);
});

describe("the --avatar-accent custom property", () => {
  test("is set to the accent and removed again when there is none", () => {
    const { rerender } = renderHook(
      ({ hex }: { hex: string | null }) => useAvatarAccentVar(hex),
      { initialProps: { hex: ORANGE as string | null } },
    );
    expect(readVar(AVATAR_ACCENT_CSS_VAR)).toBe(ORANGE);

    rerender({ hex: null });
    expect(readVar(AVATAR_ACCENT_CSS_VAR)).toBe("");
  });

  test("carries its ink, so a surface filled with it never guesses", () => {
    const { rerender } = renderHook(
      ({ hex }: { hex: string | null }) => useAvatarAccentVar(hex),
      { initialProps: { hex: YELLOW as string | null } },
    );
    expect(readVar(AVATAR_ACCENT_INK_CSS_VAR)).toBe("#1A1A1A");

    rerender({ hex: null });
    // Cleared together with the accent: an ink with no accent under it would
    // tell a fallback-coloured surface to paint for a colour it is not wearing.
    expect(readVar(AVATAR_ACCENT_CSS_VAR)).toBe("");
    expect(readVar(AVATAR_ACCENT_FILL_CSS_VAR)).toBe("");
    expect(readVar(AVATAR_ACCENT_INK_CSS_VAR)).toBe("");
  });
});

describe("avatarAccentVars", () => {
  test("carries the accent, the surface it fills, and the ink on that surface", () => {
    // Light enough that white is about 1.6:1, so the ink is the near-black,
    // and text reads on the accent itself, so the fill is the accent.
    expect(avatarAccentVars(YELLOW)).toEqual({
      [AVATAR_ACCENT_CSS_VAR]: YELLOW,
      [AVATAR_ACCENT_FILL_CSS_VAR]: YELLOW,
      [AVATAR_ACCENT_INK_CSS_VAR]: "#1A1A1A",
    });
    expect(avatarAccentVars(NAVY)).toEqual({
      [AVATAR_ACCENT_CSS_VAR]: NAVY,
      [AVATAR_ACCENT_FILL_CSS_VAR]: NAVY,
      [AVATAR_ACCENT_INK_CSS_VAR]: "#FFFFFF",
    });
  });

  test("a mid-grey keeps its accent and fills with a colour text reads on", () => {
    // The accent stays what the assistant is, for the chrome drawn over video;
    // only the surface that has to carry a label moves.
    const vars = avatarAccentVars(MID_GREY);

    expect(vars[AVATAR_ACCENT_CSS_VAR]).toBe(MID_GREY);
    expect(vars[AVATAR_ACCENT_FILL_CSS_VAR]).not.toBe(MID_GREY);
    expect(vars[AVATAR_ACCENT_INK_CSS_VAR]).toBe("#FFFFFF");
  });

  test("publishes nothing at all for an assistant with no accent", () => {
    // Not a neutral pair: absent is what leaves every consumer on the fallback
    // colour AND the fallback ink it was designed with.
    expect(avatarAccentVars(null)).toEqual({});
    expect(avatarAccentVars(undefined)).toEqual({});
  });
});

describe("publishing the accent", () => {
  test("a second publisher unmounting leaves the surviving one's value alone", () => {
    // "One publisher" is a convention, not something the module enforces: a
    // test harness or a transient double-mount produces two. A cleanup that
    // cleared this would let the departing one null the value the survivor
    // published, and the survivor never re-publishes (its dep did not change),
    // so the island would silently fall back to the native neutral gray.
    renderHook(() => useAvatarAccentVar(ORANGE));
    expect(getPublishedAvatarAccentHex()).toBe(ORANGE);

    const second = renderHook(() => useAvatarAccentVar(ORANGE));
    second.unmount();

    expect(getPublishedAvatarAccentHex()).toBe(ORANGE);
  });

  test("a null accent is published as null so readers fall back", () => {
    renderHook(() => useAvatarAccentVar(null));
    expect(getPublishedAvatarAccentHex()).toBeNull();
  });
});
