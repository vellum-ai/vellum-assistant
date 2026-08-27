import { describe, expect, test } from "bun:test";

import {
  DEFAULT_APP_ICON_TRAITS,
  appIconNameForAvatar,
  appIconNameForTraits,
  isAvatarAppIcon,
  resolveAppIconTarget,
  traitsForAppIconName,
} from "./avatar-app-icon";
import type { AvatarState } from "@/types/avatar";

/**
 * Pins two contracts:
 *
 *   1. Only `kind: "character"` avatars ever produce an icon name, so uploaded
 *      images, AI-generated avatars, and "no avatar" can never be offered or
 *      applied an app icon.
 *   2. The name format itself, which is shared with the icon bundle generator:
 *      the bundles are emitted under exactly these names, so changing the
 *      literal below without regenerating them silently breaks every install.
 *      `clients/ios/scripts/__tests__/generate-avatar-icons.test.ts` pins the
 *      same literal from the generator's side. Both producers are pinned to it:
 *      the picker composes names from loose traits, the sync path derives them
 *      from an avatar, and the two must land on the same string.
 */

/** A character avatar by default; `overrides` swaps in the other kinds. */
function avatarState(
  traits: AvatarState["traits"],
  overrides: Partial<AvatarState> = {},
): AvatarState {
  return {
    kind: "character",
    traits,
    source: "builder",
    image: null,
    ...overrides,
  };
}

describe("appIconNameForTraits", () => {
  test("an eyes-on-color pair composes the generator's icon name", () => {
    expect(appIconNameForTraits("grumpy", "green")).toBe(
      "avatar-eyes-grumpy-green",
    );
  });
});

describe("appIconNameForAvatar", () => {
  test("character traits map to the generator's icon name", () => {
    const name = appIconNameForAvatar(
      avatarState({
        bodyShape: "blob",
        eyeStyle: "grumpy",
        color: "green",
      }),
    );
    expect(name).toBe("avatar-eyes-grumpy-green");
  });

  test("an avatar lands on the same name the trait pair composes", () => {
    const name = appIconNameForAvatar(
      avatarState({
        bodyShape: "blob",
        eyeStyle: "grumpy",
        color: "green",
      }),
    );
    expect(name).toBe(appIconNameForTraits("grumpy", "green"));
  });

  test("body shape does not reach the name", () => {
    const blob = appIconNameForAvatar(
      avatarState({ bodyShape: "blob", eyeStyle: "grumpy", color: "green" }),
    );
    const nebula = appIconNameForAvatar(
      avatarState({ bodyShape: "nebula", eyeStyle: "grumpy", color: "green" }),
    );
    expect(nebula).toBe(blob);
  });

  test("an uploaded image avatar has no icon, even with stale traits", () => {
    const state = avatarState(
      { bodyShape: "blob", eyeStyle: "grumpy", color: "green" },
      { kind: "image", source: "upload", image: { updatedAt: "x", etag: "y" } },
    );
    expect(appIconNameForAvatar(state)).toBeNull();
  });

  test("an AI-generated image avatar has no icon", () => {
    const state = avatarState(null, {
      kind: "image",
      source: "ai",
      image: { updatedAt: "x", etag: "y" },
    });
    expect(appIconNameForAvatar(state)).toBeNull();
  });

  test("kind none has no icon", () => {
    expect(
      appIconNameForAvatar(avatarState(null, { kind: "none", source: null })),
    ).toBeNull();
  });

  test("a null state has no icon", () => {
    expect(appIconNameForAvatar(null)).toBeNull();
  });

  test("malformed traits have no icon instead of a name with holes", () => {
    const malformed = { bodyShape: "blob", color: "green" } as unknown;
    const state = avatarState(malformed as AvatarState["traits"]);
    expect(appIconNameForAvatar(state)).toBeNull();
  });

  // A character always carries all three traits, so traits missing the one the
  // name leaves out are as malformed as any other.
  test("traits without a body shape have no icon", () => {
    const malformed = { eyeStyle: "grumpy", color: "green" } as unknown;
    const state = avatarState(malformed as AvatarState["traits"]);
    expect(appIconNameForAvatar(state)).toBeNull();
  });
});

describe("resolveAppIconTarget", () => {
  const supportedShell = {
    supported: true,
    current: null,
    available: ["avatar-eyes-grumpy-green"],
  };

  test("a bundled icon resolves to an available match", () => {
    const result = resolveAppIconTarget(
      avatarState({
        bodyShape: "blob",
        eyeStyle: "grumpy",
        color: "green",
      }),
      supportedShell,
    );
    expect(result).toEqual({
      target: "avatar-eyes-grumpy-green",
      availableMatch: true,
    });
  });

  test("a trait the installed shell has no bundle for is a no-op", () => {
    const result = resolveAppIconTarget(
      avatarState({
        bodyShape: "nebula",
        eyeStyle: "smitten",
        color: "chartreuse",
      }),
      supportedShell,
    );
    expect(result).toEqual({
      target: "avatar-eyes-smitten-chartreuse",
      availableMatch: false,
    });
  });

  test("an unsupported shell never matches, whatever it lists", () => {
    const result = resolveAppIconTarget(
      avatarState({
        bodyShape: "blob",
        eyeStyle: "grumpy",
        color: "green",
      }),
      { ...supportedShell, supported: false },
    );
    expect(result).toEqual({
      target: "avatar-eyes-grumpy-green",
      availableMatch: false,
    });
  });

  test("a non-character avatar never matches", () => {
    const result = resolveAppIconTarget(
      avatarState(null, { kind: "none", source: null }),
      supportedShell,
    );
    expect(result).toEqual({ target: null, availableMatch: false });
  });
});

describe("isAvatarAppIcon", () => {
  test("recognizes a name this feature produced", () => {
    const name = appIconNameForAvatar(
      avatarState({
        bodyShape: "blob",
        eyeStyle: "curious",
        color: "cosmic-purple",
      }),
    );

    expect(isAvatarAppIcon(name)).toBe(true);
  });

  test("the default icon is not one of ours", () => {
    expect(isAvatarAppIcon(null)).toBe(false);
  });

  test("an alternate from some other feature is not one of ours", () => {
    expect(isAvatarAppIcon("seasonal-winter")).toBe(false);
  });
});

describe("traitsForAppIconName", () => {
  test("a composed name reads back as the pair it was composed from", () => {
    expect(
      traitsForAppIconName(appIconNameForTraits("grumpy", "green")),
    ).toEqual({ eyeStyle: "grumpy", color: "green" });
  });

  test("a color id with a dash in it survives the round trip", () => {
    const name = appIconNameForTraits("curious", "cosmic-purple");
    expect(traitsForAppIconName(name)).toEqual({
      eyeStyle: "curious",
      color: "cosmic-purple",
    });
  });

  test("the default icon reads as no pair", () => {
    expect(traitsForAppIconName(null)).toBeNull();
  });

  test("an alternate from some other feature reads as no pair", () => {
    expect(traitsForAppIconName("seasonal-winter")).toBeNull();
  });

  test("a name with a half of the pair missing reads as no pair", () => {
    expect(traitsForAppIconName("avatar-eyes-grumpy")).toBeNull();
    expect(traitsForAppIconName("avatar-eyes-grumpy-")).toBeNull();
    expect(traitsForAppIconName("avatar-eyes--green")).toBeNull();
  });
});

describe("DEFAULT_APP_ICON_TRAITS", () => {
  // Pinned to `clients/ios/App/App/AppIcon.icon`, which draws quirky eyes on
  // the green field. A preview of "no alternate applied" is only honest while
  // these two agree.
  test("names the pair the shipped default icon is drawn from", () => {
    expect(DEFAULT_APP_ICON_TRAITS).toEqual({
      eyeStyle: "quirky",
      color: "green",
    });
  });
});
