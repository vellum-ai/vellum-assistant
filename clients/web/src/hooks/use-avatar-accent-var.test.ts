import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import {
  AVATAR_ACCENT_CSS_VAR,
  getPublishedAvatarAccentHex,
  useAvatarAccentVar,
} from "./use-avatar-accent-var";

const ORANGE = "#E9642F";

afterEach(() => {
  cleanup();
  document.documentElement.style.removeProperty(AVATAR_ACCENT_CSS_VAR);
});

describe("the --avatar-accent custom property", () => {
  test("is set to the accent and removed again when there is none", () => {
    const { rerender } = renderHook(
      ({ hex }: { hex: string | null }) => useAvatarAccentVar(hex),
      { initialProps: { hex: ORANGE as string | null } },
    );
    expect(
      document.documentElement.style.getPropertyValue(AVATAR_ACCENT_CSS_VAR),
    ).toBe(ORANGE);

    rerender({ hex: null });
    expect(
      document.documentElement.style.getPropertyValue(AVATAR_ACCENT_CSS_VAR),
    ).toBe("");
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
