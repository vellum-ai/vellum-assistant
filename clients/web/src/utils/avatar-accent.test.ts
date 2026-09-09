import { describe, expect, test } from "bun:test";

import type { AvatarState, CharacterTraits } from "@/types/avatar";
import { BUNDLED_COMPONENTS } from "@/utils/avatar-bundled-components";

import { resolveAvatarAccentHex } from "./avatar-accent";

const ORANGE = BUNDLED_COMPONENTS.colors.find((c) => c.id === "orange")!.hex;
const FIRST = BUNDLED_COMPONENTS.colors[0]!.hex;

const traitsWithColor = (color: string) =>
  ({ bodyShape: "blob", eyeStyle: "grumpy", color }) as CharacterTraits;

const imageState = (accent: AvatarState["accent"]): AvatarState => ({
  kind: "image",
  traits: null,
  source: "upload",
  image: { updatedAt: "2026-01-01T00:00:00.000Z", etag: "abc" },
  accent,
});

describe("resolveAvatarAccentHex", () => {
  test("the daemon's accent wins whenever it is present", () => {
    expect(
      resolveAvatarAccentHex({
        state: imageState({ hex: "#c81e1e", source: "derived" }),
        components: BUNDLED_COMPONENTS,
        traits: null,
        customImageUrl: "blob:image",
      }),
    ).toBe("#c81e1e");
    // Including over a character's own palette colour, which is what a
    // custom accent set over a character would be.
    expect(
      resolveAvatarAccentHex({
        state: {
          kind: "character",
          traits: traitsWithColor("orange"),
          source: "builder",
          image: null,
          accent: { hex: "#12ab34", source: "custom" },
        },
        components: BUNDLED_COMPONENTS,
        traits: traitsWithColor("orange"),
        customImageUrl: null,
      }),
    ).toBe("#12ab34");
  });

  test("a character without a daemon accent resolves its palette colour", () => {
    expect(
      resolveAvatarAccentHex({
        components: BUNDLED_COMPONENTS,
        traits: traitsWithColor("orange"),
        customImageUrl: null,
      }),
    ).toBe(ORANGE);
  });

  test("a traits-less avatar resolves the first palette colour its default creature is drawn in", () => {
    expect(
      resolveAvatarAccentHex({
        components: BUNDLED_COMPONENTS,
        traits: null,
        customImageUrl: null,
      }),
    ).toBe(FIRST);
    expect(
      resolveAvatarAccentHex({
        state: {
          kind: "none",
          traits: null,
          source: null,
          image: null,
          accent: null,
        },
        components: BUNDLED_COMPONENTS,
        traits: null,
        customImageUrl: null,
      }),
    ).toBe(FIRST);
  });

  test("an image with no daemon accent has no colour to match", () => {
    expect(
      resolveAvatarAccentHex({
        components: BUNDLED_COMPONENTS,
        traits: null,
        customImageUrl: "blob:image",
      }),
    ).toBeNull();
    expect(
      resolveAvatarAccentHex({
        state: imageState(null),
        components: BUNDLED_COMPONENTS,
        traits: null,
        customImageUrl: null,
      }),
    ).toBeNull();
  });

  test("saved traits outrank an image, as they do in ChatAvatar", () => {
    // The character is what renders, so its colour is the accent.
    expect(
      resolveAvatarAccentHex({
        components: BUNDLED_COMPONENTS,
        traits: traitsWithColor("orange"),
        customImageUrl: "blob:image",
      }),
    ).toBe(ORANGE);
  });

  test("null while the avatar is still loading", () => {
    expect(
      resolveAvatarAccentHex({
        components: null,
        traits: null,
        customImageUrl: null,
      }),
    ).toBeNull();
  });
});
