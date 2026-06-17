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

const { resolveAvatarRender } = await import("@/utils/avatar-render");

// The compositor is mocked, so these only need to be present, not valid.
const components = {} as CharacterComponents;
const traits = {
  bodyShape: "round",
  eyeStyle: "dot",
  color: "green",
} as CharacterTraits;

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
    expect(resolveAvatarRender(null, null, null, 512)).toEqual({ kind: "none" });
  });

  test("resolves to none when composeSvg throws and there is no custom image", () => {
    composeSvgMock.mockImplementation(() => {
      throw new Error("unknown trait id");
    });
    expect(resolveAvatarRender(null, components, traits, 512)).toEqual({
      kind: "none",
    });
  });
});
