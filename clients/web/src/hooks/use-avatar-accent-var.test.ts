import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  AVATAR_ACCENT_CSS_VAR,
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

const readVar = (name: string) =>
  document.documentElement.style.getPropertyValue(name);

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(AVATAR_ACCENT_CSS_VAR);
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
    expect(readVar(AVATAR_ACCENT_INK_CSS_VAR)).toBe("");
  });
});

describe("avatarAccentVars", () => {
  test("pairs the accent with the ink WCAG picks for it", () => {
    // Light enough that white is about 1.6:1, so the ink is the near-black.
    expect(avatarAccentVars(YELLOW)).toEqual({
      [AVATAR_ACCENT_CSS_VAR]: YELLOW,
      [AVATAR_ACCENT_INK_CSS_VAR]: "#1A1A1A",
    });
    expect(avatarAccentVars(NAVY)).toEqual({
      [AVATAR_ACCENT_CSS_VAR]: NAVY,
      [AVATAR_ACCENT_INK_CSS_VAR]: "#FFFFFF",
    });
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
