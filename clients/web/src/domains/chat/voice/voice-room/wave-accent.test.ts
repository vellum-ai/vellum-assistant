import { describe, expect, test } from "bun:test";

import type { CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import { resolveWaveAccentHex } from "./wave-accent";

const traitsWithColor = (color: string) =>
  ({ bodyShape: "blob", eyeStyle: "grumpy", color }) as CharacterTraits;

describe("resolveWaveAccentHex", () => {
  test("uses the explicit trait color when the avatar has one", () => {
    const orange = BUNDLED_COMPONENTS.colors.find((c) => c.id === "orange")!.hex;
    expect(resolveWaveAccentHex(BUNDLED_COMPONENTS, traitsWithColor("orange"))).toBe(
      orange,
    );
  });

  test("falls back to the first palette color for a default (traits-less) avatar — matching what ChatAvatar renders, so the waves don't drift to indigo", () => {
    const firstColor = BUNDLED_COMPONENTS.colors[0]!.hex;
    expect(resolveWaveAccentHex(BUNDLED_COMPONENTS, null)).toBe(firstColor);
  });

  test("returns null when there is no character to color (custom image / not yet loaded)", () => {
    expect(resolveWaveAccentHex(null, null)).toBeNull();
  });
});
