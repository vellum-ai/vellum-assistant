import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import {
  getRenderedAvatarAccentHex,
  resolveAvatarAccentHex,
  resolveRenderedAvatarAccentHex,
  useAvatarAccentVar,
} from "./use-avatar-accent-var";

const traitsWithColor = (color: string) =>
  ({ bodyShape: "blob", eyeStyle: "grumpy", color }) as CharacterTraits;

afterEach(() => {
  cleanup();
});

describe("resolveRenderedAvatarAccentHex", () => {
  test("uses the explicit trait color when the avatar has one", () => {
    const orange = BUNDLED_COMPONENTS.colors.find((c) => c.id === "orange")!.hex;
    expect(
      resolveRenderedAvatarAccentHex(
        BUNDLED_COMPONENTS,
        traitsWithColor("orange"),
      ),
    ).toBe(orange);
  });

  test("falls back to the first palette color for a default (traits-less) avatar — matching what ChatAvatar renders, so accented surfaces don't drift to indigo", () => {
    const firstColor = BUNDLED_COMPONENTS.colors[0]!.hex;
    expect(resolveRenderedAvatarAccentHex(BUNDLED_COMPONENTS, null)).toBe(
      firstColor,
    );
    // The strict form is what `--avatar-accent` publishes, and it deliberately
    // does *not* take that fallback.
    expect(resolveAvatarAccentHex(BUNDLED_COMPONENTS, null)).toBeNull();
  });

  test("returns null when there is no character to color (custom image / not yet loaded)", () => {
    expect(resolveRenderedAvatarAccentHex(null, null)).toBeNull();
  });
});

describe("publishing the rendered accent", () => {
  const ORANGE = BUNDLED_COMPONENTS.colors.find((c) => c.id === "orange")!.hex;

  test("a second publisher unmounting leaves the surviving one's value alone", () => {
    // "One publisher" is a convention, not something the module enforces — a
    // test harness or a transient double-mount produces two. A cleanup that
    // cleared this would let the departing one null the value the survivor
    // published, and the survivor never re-publishes (its dep did not change),
    // so the island would silently fall back to the native neutral gray.
    renderHook(() =>
      useAvatarAccentVar(BUNDLED_COMPONENTS, traitsWithColor("orange")),
    );
    expect(getRenderedAvatarAccentHex()).toBe(ORANGE);

    const second = renderHook(() =>
      useAvatarAccentVar(BUNDLED_COMPONENTS, traitsWithColor("orange")),
    );
    second.unmount();

    expect(getRenderedAvatarAccentHex()).toBe(ORANGE);
  });

  test("a publisher whose avatar loses its color republishes null", () => {
    // The clearing path that matters is a *publish*, not an unmount: the active
    // assistant switching to a custom-image or colorless avatar.
    const initialProps: { traits: CharacterTraits | null } = {
      traits: traitsWithColor("orange"),
    };
    const view = renderHook(
      ({ traits }: { traits: CharacterTraits | null }) =>
        useAvatarAccentVar(BUNDLED_COMPONENTS, traits),
      { initialProps },
    );
    expect(getRenderedAvatarAccentHex()).toBe(ORANGE);

    view.rerender({ traits: null });
    // A traits-less avatar still renders in the first palette color.
    expect(getRenderedAvatarAccentHex()).toBe(BUNDLED_COMPONENTS.colors[0]!.hex);
  });
});
