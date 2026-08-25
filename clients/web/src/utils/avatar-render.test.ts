import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { CharacterComponents, CharacterTraits } from "@/types/avatar";

// `composeSvg` is the trait→SVG compositor; mock it so the precedence logic is
// tested in isolation. A `throw` simulates unknown trait IDs, the documented
// "no character avatar" fall-through.
const composeSvgMock = mock(
  (..._args: unknown[]): string => "<svg>character</svg>",
);
mock.module("@/utils/avatar-svg-compositor", () => ({
  composeSvg: composeSvgMock,
}));

const { resolveAvatarRender, resolveEffectiveTraits } =
  await import("@/utils/avatar-render");

// The compositor is mocked, so these only need to be present, not valid.
const components = {} as CharacterComponents;
const traits = {
  bodyShape: "round",
  eyeStyle: "dot",
  color: "green",
} as CharacterTraits;

/**
 * A palette, for the paths that read it. The first of each list is the default
 * character, so the second entries are there to prove which one is taken.
 */
const palette = {
  bodyShapes: [{ id: "blob" }, { id: "cloud" }],
  eyeStyles: [{ id: "grumpy" }, { id: "angry" }],
  colors: [{ id: "green" }, { id: "orange" }],
} as unknown as CharacterComponents;

/** A palette served empty, which has no default character to derive. */
const emptyPalette = {
  bodyShapes: [],
  eyeStyles: [],
  colors: [],
} as unknown as CharacterComponents;

beforeEach(() => {
  composeSvgMock.mockReset();
  composeSvgMock.mockReturnValue("<svg>character</svg>");
});

describe("resolveAvatarRender", () => {
  test("prefers the character avatar when traits + components are present", () => {
    const result = resolveAvatarRender(
      "https://example.com/custom.png",
      components,
      traits,
      512,
    );
    expect(result.kind).toBe("character");
    if (result.kind === "character") {
      expect(result.svg).toBe("<svg>character</svg>");
      expect(result.dataUri).toBe(
        `data:image/svg+xml,${encodeURIComponent("<svg>character</svg>")}`,
      );
    }
    // Character wins over the custom image, even though one was provided.
    expect(composeSvgMock).toHaveBeenCalledWith(
      components,
      "round",
      "dot",
      "green",
      512,
    );
  });

  test("falls through to the custom image when there is no character", () => {
    const result = resolveAvatarRender(
      "https://example.com/custom.png",
      null,
      null,
      512,
    );
    expect(result).toEqual({
      kind: "image",
      url: "https://example.com/custom.png",
    });
    expect(composeSvgMock).not.toHaveBeenCalled();
  });

  test("falls through to the custom image when composeSvg throws", () => {
    composeSvgMock.mockImplementation(() => {
      throw new Error("unknown trait id");
    });
    const result = resolveAvatarRender(
      "https://example.com/custom.png",
      components,
      traits,
      512,
    );
    expect(result).toEqual({
      kind: "image",
      url: "https://example.com/custom.png",
    });
  });

  test("resolves to none when neither a character nor a custom image exists", () => {
    expect(resolveAvatarRender(null, null, null, 512)).toEqual({
      kind: "none",
    });
  });

  test("resolves to none when composeSvg throws and there is no custom image", () => {
    composeSvgMock.mockImplementation(() => {
      throw new Error("unknown trait id");
    });
    expect(resolveAvatarRender(null, components, traits, 512)).toEqual({
      kind: "none",
    });
    // The assistant's own traits are not retried as the default character: it
    // chose them, and the default is for an assistant that chose none.
    expect(composeSvgMock).toHaveBeenCalledTimes(1);
  });

  test("draws the default character when there are components but no traits", () => {
    // What `ChatAvatar` renders for an assistant that never opened the avatar
    // builder, so every off-screen surface has to draw the same creature
    // instead of falling back to the Vellum mark.
    const result = resolveAvatarRender(null, palette, null, 512);
    expect(result.kind).toBe("character");
    expect(composeSvgMock).toHaveBeenCalledWith(
      palette,
      "blob",
      "grumpy",
      "green",
      512,
    );
  });

  test("prefers a custom image over the default character", () => {
    // Saved traits outrank an uploaded image; a default nobody picked does not.
    expect(
      resolveAvatarRender("https://example.com/custom.png", palette, null, 512),
    ).toEqual({ kind: "image", url: "https://example.com/custom.png" });
    expect(composeSvgMock).not.toHaveBeenCalled();
  });

  test("resolves to none when the palette has no default to derive", () => {
    expect(resolveAvatarRender(null, emptyPalette, null, 512)).toEqual({
      kind: "none",
    });
    expect(composeSvgMock).not.toHaveBeenCalled();
  });
});

describe("resolveEffectiveTraits", () => {
  test("returns the assistant's own traits untouched", () => {
    expect(resolveEffectiveTraits(palette, traits)).toBe(traits);
  });

  test("derives the first of each component when there are no traits", () => {
    expect(resolveEffectiveTraits(palette, null)).toEqual({
      bodyShape: "blob",
      eyeStyle: "grumpy",
      color: "green",
    });
  });

  test("returns null without components, or with an empty palette", () => {
    expect(resolveEffectiveTraits(null, null)).toBeNull();
    expect(resolveEffectiveTraits(emptyPalette, null)).toBeNull();
  });
});
