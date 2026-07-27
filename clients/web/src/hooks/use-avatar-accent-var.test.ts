import { describe, expect, test } from "bun:test";

import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import {
  resolveAvatarAccentHex,
  resolveRenderedAvatarAccentHex,
} from "./use-avatar-accent-var";

const traitsWithColor = (color: string) =>
  ({ bodyShape: "blob", eyeStyle: "grumpy", color }) as CharacterTraits;

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
