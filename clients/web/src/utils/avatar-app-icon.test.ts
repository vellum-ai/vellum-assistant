import { describe, expect, test } from "bun:test";

import {
  appIconNameForAvatar,
  isAvatarAppIcon,
  resolveAppIconTarget,
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

describe("appIconNameForAvatar", () => {
  test("character traits map to the generator's icon name", () => {
    const name = appIconNameForAvatar(
      avatarState({
        bodyShape: "blob",
        eyeStyle: "grumpy",
        color: "green",
      }),
    );
    expect(name).toBe("avatar-blob-grumpy-green");
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
});

describe("resolveAppIconTarget", () => {
  const supportedShell = {
    supported: true,
    current: null,
    available: ["avatar-blob-grumpy-green"],
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
      target: "avatar-blob-grumpy-green",
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
      target: "avatar-nebula-smitten-chartreuse",
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
      target: "avatar-blob-grumpy-green",
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
