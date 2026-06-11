/**
 * Tests for {@link parsePluginArtifact} — the `vellum.artifact` descriptor
 * reader. A descriptor is surfaced only when both fields are well-formed
 * (https URL + 64-hex sha256); every malformed or partial shape is "no
 * artifact yet" (`null`) so callers never offer an unverifiable download.
 */

import { describe, expect, test } from "bun:test";

import { parsePluginArtifact } from "../plugin-artifact.js";

const VALID_SHA = "a".repeat(64);

describe("parsePluginArtifact", () => {
  test("returns the descriptor when url + sha256 are well-formed", () => {
    // GIVEN a package.json with a complete vellum.artifact block
    const pkg = {
      vellum: {
        artifact: {
          url: "https://example.com/releases/v1.0.0/App.dmg",
          sha256: VALID_SHA,
        },
      },
    };

    // WHEN we parse it
    const artifact = parsePluginArtifact(pkg);

    // THEN both fields come through unchanged
    expect(artifact).toEqual({
      url: "https://example.com/releases/v1.0.0/App.dmg",
      sha256: VALID_SHA,
    });
  });

  test("surfaces an optional label when the plugin names the download", () => {
    // GIVEN a block that labels its artifact (e.g. for multi-artifact plugins)
    const pkg = {
      vellum: {
        artifact: {
          url: "https://example.com/App.dmg",
          sha256: VALID_SHA,
          label: "Download for macOS",
        },
      },
    };

    // WHEN we parse it
    const artifact = parsePluginArtifact(pkg);

    // THEN the label comes through alongside url + sha256
    expect(artifact).toEqual({
      url: "https://example.com/App.dmg",
      sha256: VALID_SHA,
      label: "Download for macOS",
    });
  });

  test("trims a label and drops it when blank, keeping the descriptor", () => {
    // GIVEN a descriptor whose label is whitespace-only
    const pkg = {
      vellum: {
        artifact: {
          url: "https://example.com/App.dmg",
          sha256: VALID_SHA,
          label: "   ",
        },
      },
    };

    // WHEN we parse it
    const artifact = parsePluginArtifact(pkg);

    // THEN the blank label is dropped but the artifact still surfaces
    expect(artifact).toEqual({
      url: "https://example.com/App.dmg",
      sha256: VALID_SHA,
    });
  });

  test("ignores a non-string label without dropping the descriptor", () => {
    // GIVEN a label of the wrong type
    const pkg = {
      vellum: {
        artifact: {
          url: "https://example.com/App.dmg",
          sha256: VALID_SHA,
          label: 42,
        },
      },
    };

    // WHEN we parse it
    const artifact = parsePluginArtifact(pkg);

    // THEN the bad label is ignored but url + sha256 still come through
    expect(artifact).toEqual({
      url: "https://example.com/App.dmg",
      sha256: VALID_SHA,
    });
  });

  test("ignores extra fields inside the artifact block", () => {
    // GIVEN a block carrying fields beyond url + sha256
    const pkg = {
      vellum: {
        artifact: {
          url: "https://example.com/App.dmg",
          sha256: VALID_SHA,
          platform: "macos",
          minOS: "13.0",
        },
      },
    };

    // WHEN we parse it
    const artifact = parsePluginArtifact(pkg);

    // THEN only the two recognised fields are surfaced
    expect(artifact).toEqual({
      url: "https://example.com/App.dmg",
      sha256: VALID_SHA,
    });
  });

  test.each([
    ["no vellum block", { name: "x" }],
    ["no artifact block", { vellum: {} }],
    [
      "empty sha256 (bootstrap placeholder)",
      {
        vellum: {
          artifact: { url: "https://example.com/App.dmg", sha256: "" },
        },
      },
    ],
    [
      "sha256 too short",
      {
        vellum: {
          artifact: { url: "https://example.com/App.dmg", sha256: "abc" },
        },
      },
    ],
    [
      "sha256 with uppercase hex",
      {
        vellum: {
          artifact: {
            url: "https://example.com/App.dmg",
            sha256: "A".repeat(64),
          },
        },
      },
    ],
    [
      "non-https url",
      {
        vellum: {
          artifact: { url: "http://example.com/App.dmg", sha256: VALID_SHA },
        },
      },
    ],
    ["missing url", { vellum: { artifact: { sha256: VALID_SHA } } }],
    ["artifact is not an object", { vellum: { artifact: "App.dmg" } }],
    ["vellum is an array", { vellum: [] }],
  ])("returns null for %s", (_label, pkg) => {
    // WHEN we parse a malformed / partial descriptor
    // THEN nothing is surfaced
    expect(parsePluginArtifact(pkg)).toBeNull();
  });

  test.each([
    ["null", null],
    ["a string", "not-a-package"],
    ["an array", []],
    ["a number", 42],
  ])("returns null when package.json is %s", (_label, value) => {
    // WHEN we parse a non-object package.json value
    // THEN nothing is surfaced
    expect(parsePluginArtifact(value)).toBeNull();
  });
});
