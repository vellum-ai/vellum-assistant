import { describe, expect, test } from "bun:test";

import {
  AVATAR_FIELD_MAX_LENGTH,
  deriveAvatarFromLegacyFiles,
  parseAvatarManifest,
  resolveAvatarFromFiles,
} from "../manifest.js";

const overlong = "x".repeat(AVATAR_FIELD_MAX_LENGTH + 1);

const traits = { bodyShape: "round", eyeStyle: "dot", color: "#abc" };
const image = { updatedAt: "2026-01-01T00:00:00.000Z", etag: "abc" };

describe("parseAvatarManifest", () => {
  test("accepts a character manifest", () => {
    expect(
      parseAvatarManifest({ kind: "character", traits, source: "builder" }),
    ).toEqual({
      kind: "character",
      traits,
      source: "builder",
      image: null,
      accent: null,
    });
  });

  test("accepts an image manifest", () => {
    expect(parseAvatarManifest({ kind: "image", image })).toEqual({
      kind: "image",
      traits: null,
      source: null,
      image,
      accent: null,
    });
  });

  test("keeps a well-formed accent on a character or image manifest", () => {
    const accent = { hex: "#e9642f", source: "custom" as const };
    expect(parseAvatarManifest({ kind: "image", image, accent })).toEqual({
      kind: "image",
      traits: null,
      source: null,
      image,
      accent,
    });
    expect(parseAvatarManifest({ kind: "character", traits, accent })).toEqual({
      kind: "character",
      traits,
      source: null,
      image: null,
      accent,
    });
  });

  test.each([
    ["a short hex", { hex: "#abc", source: "derived" }],
    ["an unknown source", { hex: "#e9642f", source: "guess" }],
    ["a missing source", { hex: "#e9642f" }],
    ["a non-object", "#e9642f"],
  ])(
    "normalizes %s accent to null without failing the manifest",
    (_label, accent) => {
      expect(parseAvatarManifest({ kind: "image", image, accent })).toEqual({
        kind: "image",
        traits: null,
        source: null,
        image,
        accent: null,
      });
    },
  );

  test("drops an accent from a none manifest", () => {
    expect(
      parseAvatarManifest({
        kind: "none",
        accent: { hex: "#e9642f", source: "custom" },
      }),
    ).toEqual({
      kind: "none",
      traits: null,
      source: null,
      image: null,
      accent: null,
    });
  });

  test("accepts kind none without a payload", () => {
    expect(parseAvatarManifest({ kind: "none" })).toEqual({
      kind: "none",
      traits: null,
      source: null,
      image: null,
      accent: null,
    });
  });

  test("rejects an overlong trait or image field", () => {
    expect(
      parseAvatarManifest({
        kind: "character",
        traits: { ...traits, color: overlong },
      }),
    ).toBeNull();
    expect(
      parseAvatarManifest({
        kind: "image",
        image: { ...image, etag: overlong },
      }),
    ).toBeNull();
    expect(
      parseAvatarManifest({
        kind: "character",
        traits: { ...traits, color: "x".repeat(AVATAR_FIELD_MAX_LENGTH) },
      }),
    ).not.toBeNull();
  });

  test("normalizes an unknown source to null", () => {
    expect(
      parseAvatarManifest({ kind: "image", image, source: "unknown" }),
    ).toEqual({
      kind: "image",
      traits: null,
      source: null,
      image,
      accent: null,
    });
    expect(parseAvatarManifest({ kind: "none", source: 7 })).toEqual({
      kind: "none",
      traits: null,
      source: null,
      image: null,
      accent: null,
    });
  });

  test("drops payload irrelevant to the kind", () => {
    expect(
      parseAvatarManifest({ kind: "image", image, traits: { bodyShape: 1 } }),
    ).toEqual({
      kind: "image",
      traits: null,
      source: null,
      image,
      accent: null,
    });
    expect(
      parseAvatarManifest({ kind: "character", traits, image: "stale" }),
    ).toEqual({
      kind: "character",
      traits,
      source: null,
      image: null,
      accent: null,
    });
    expect(parseAvatarManifest({ kind: "none", traits, image })).toEqual({
      kind: "none",
      traits: null,
      source: null,
      image: null,
      accent: null,
    });
  });

  test.each([
    ["non-object", "nope"],
    ["missing kind", {}],
    ["invalid kind", { kind: "sprite", traits }],
    ["character without traits", { kind: "character" }],
    [
      "character with incomplete traits",
      { kind: "character", traits: { bodyShape: "round" } },
    ],
    ["image without meta", { kind: "image" }],
    ["image with empty etag", { kind: "image", image: { ...image, etag: "" } }],
  ])("rejects %s", (_label, value) => {
    expect(parseAvatarManifest(value)).toBeNull();
  });
});

describe("deriveAvatarFromLegacyFiles", () => {
  test("overlong traits are invalid", () => {
    expect(
      deriveAvatarFromLegacyFiles({
        traitsJson: { ...traits, bodyShape: overlong },
        hasImage: true,
      }),
    ).toEqual({ kind: "image" });
  });

  test("valid traits win over a present image", () => {
    expect(
      deriveAvatarFromLegacyFiles({ traitsJson: traits, hasImage: true }),
    ).toEqual({ kind: "character", traits });
  });

  test("invalid traits fall back to the image", () => {
    expect(
      deriveAvatarFromLegacyFiles({
        traitsJson: { bodyShape: 1 },
        hasImage: true,
      }),
    ).toEqual({ kind: "image" });
  });

  test("nothing usable yields none", () => {
    expect(
      deriveAvatarFromLegacyFiles({ traitsJson: undefined, hasImage: false }),
    ).toEqual({ kind: "none" });
  });
});

describe("resolveAvatarFromFiles", () => {
  test("a valid manifest decides regardless of sidecars", () => {
    expect(
      resolveAvatarFromFiles({
        manifestJson: { kind: "none" },
        traitsJson: traits,
        hasImage: true,
      }),
    ).toEqual({ kind: "none" });
    expect(
      resolveAvatarFromFiles({
        manifestJson: { kind: "image", image },
        traitsJson: traits,
        hasImage: true,
      }),
    ).toEqual({ kind: "image", image });
  });

  test("a partial image manifest falls back to traits-first derivation", () => {
    expect(
      resolveAvatarFromFiles({
        manifestJson: { kind: "image" },
        traitsJson: traits,
        hasImage: true,
      }),
    ).toEqual({ kind: "character", traits });
  });

  test("a legacy image carries no manifest metadata", () => {
    expect(
      resolveAvatarFromFiles({
        manifestJson: undefined,
        traitsJson: undefined,
        hasImage: true,
      }),
    ).toEqual({ kind: "image", image: null });
  });
});
