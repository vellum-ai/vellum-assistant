import { describe, expect, test } from "bun:test";

import {
  parseVersion,
  compareVersions,
  compareSemver,
  isVersionCompatible,
} from "../index.js";

describe("parseVersion", () => {
  test("parses basic semver", () => {
    expect(parseVersion("1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: null,
    });
  });

  test("strips v prefix", () => {
    expect(parseVersion("v1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: null,
    });
  });

  test("strips V prefix", () => {
    expect(parseVersion("V1.2.3")).toEqual({
      major: 1,
      minor: 2,
      patch: 3,
      pre: null,
    });
  });

  test("defaults missing patch to 0", () => {
    expect(parseVersion("1.2")).toEqual({
      major: 1,
      minor: 2,
      patch: 0,
      pre: null,
    });
  });

  test("captures pre-release suffix", () => {
    expect(parseVersion("0.6.0-staging.5")).toEqual({
      major: 0,
      minor: 6,
      patch: 0,
      pre: "staging.5",
    });
  });

  test("captures pre-release with v prefix", () => {
    expect(parseVersion("v0.6.0-staging.1")).toEqual({
      major: 0,
      minor: 6,
      patch: 0,
      pre: "staging.1",
    });
  });

  test("captures hyphenated pre-release suffix", () => {
    expect(parseVersion("1.0.0-pre-release-1")).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
      pre: "pre-release-1",
    });
  });

  test("returns null for single segment", () => {
    expect(parseVersion("1")).toBeNull();
  });

  test("returns null for non-numeric segments", () => {
    expect(parseVersion("abc.def")).toBeNull();
  });

  test("returns null for empty string", () => {
    expect(parseVersion("")).toBeNull();
  });
});

describe("compareVersions", () => {
  test("equal versions return 0", () => {
    expect(compareVersions("1.2.3", "1.2.3")).toBe(0);
  });

  test("higher major returns positive", () => {
    expect(compareVersions("2.0.0", "1.0.0")).toBeGreaterThan(0);
  });

  test("lower major returns negative", () => {
    expect(compareVersions("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  test("higher minor returns positive", () => {
    expect(compareVersions("1.3.0", "1.2.0")).toBeGreaterThan(0);
  });

  test("higher patch returns positive", () => {
    expect(compareVersions("1.2.4", "1.2.3")).toBeGreaterThan(0);
  });

  test("strips v prefix for comparison", () => {
    expect(compareVersions("v1.2.3", "1.2.3")).toBe(0);
  });

  test("pre-release sorts lower than release", () => {
    expect(compareVersions("0.6.0-staging.1", "0.6.0")).toBeLessThan(0);
  });

  test("release sorts higher than pre-release", () => {
    expect(compareVersions("0.6.0", "0.6.0-staging.1")).toBeGreaterThan(0);
  });

  test("staging.1 < staging.2", () => {
    expect(compareVersions("0.6.0-staging.1", "0.6.0-staging.2")).toBeLessThan(
      0,
    );
  });

  test("staging.10 > staging.2 (numeric, not lexical)", () => {
    expect(
      compareVersions("0.6.0-staging.10", "0.6.0-staging.2"),
    ).toBeGreaterThan(0);
  });

  test("alpha < beta (lexical)", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });

  test("rc < staging (lexical)", () => {
    expect(compareVersions("1.0.0-rc", "1.0.0-staging")).toBeLessThan(0);
  });

  test("numeric identifier sorts lower than non-numeric", () => {
    expect(compareVersions("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });

  test("non-numeric identifier sorts higher than numeric", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-1")).toBeGreaterThan(0);
  });

  test("fewer pre-release identifiers sorts earlier", () => {
    expect(compareVersions("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
  });

  test("multi-segment pre-release comparison", () => {
    expect(
      compareVersions("1.0.0-alpha.beta.1", "1.0.0-alpha.beta.2"),
    ).toBeLessThan(0);
  });

  test("pre-release with multiple hyphens", () => {
    expect(
      compareVersions("1.0.0-pre-release-1", "1.0.0-pre-release-2"),
    ).toBeLessThan(0);
  });

  test("returns null if first version is unparseable", () => {
    expect(compareVersions("bad", "1.0.0")).toBeNull();
  });

  test("returns null if second version is unparseable", () => {
    expect(compareVersions("1.0.0", "bad")).toBeNull();
  });

  test("higher patch wins regardless of pre-release", () => {
    expect(compareVersions("0.6.1", "0.6.0-staging.99")).toBeGreaterThan(0);
  });

  test("lower patch loses regardless of pre-release absence", () => {
    expect(compareVersions("0.5.9", "0.6.0-staging.1")).toBeLessThan(0);
  });

  test("Array.sort produces correct semver order", () => {
    const versions = [
      "0.6.0",
      "0.6.0-staging.2",
      "0.5.9",
      "0.6.0-staging.10",
      "v0.6.0-staging.1",
      "0.6.1",
    ];
    const sorted = [...versions].sort((a, b) => compareVersions(a, b) ?? 0);
    expect(sorted).toEqual([
      "0.5.9",
      "v0.6.0-staging.1",
      "0.6.0-staging.2",
      "0.6.0-staging.10",
      "0.6.0",
      "0.6.1",
    ]);
  });
});

describe("compareSemver", () => {
  test("works identically to compareVersions for valid input", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
    expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
    expect(compareSemver("0.6.0-staging.1", "0.6.0")).toBeLessThan(0);
  });

  test("single-segment versions default missing segments to 0", () => {
    expect(compareSemver("1", "1.0.0")).toBe(0);
    expect(compareSemver("1", "2.0.0")).toBeLessThan(0);
    expect(compareSemver("2", "1.0.0")).toBeGreaterThan(0);
  });

  test("two-segment versions default missing patch to 0", () => {
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });

  test("non-numeric segments default to 0", () => {
    expect(compareSemver("bad", "0.0.0")).toBe(0);
  });

  test("safe for Array.sort without null coalescing", () => {
    const versions = [
      "0.6.0",
      "0.6.0-staging.2",
      "0.5.9",
      "0.6.0-staging.10",
      "v0.6.0-staging.1",
      "0.6.1",
    ];
    const sorted = [...versions].sort(compareSemver);
    expect(sorted).toEqual([
      "0.5.9",
      "v0.6.0-staging.1",
      "0.6.0-staging.2",
      "0.6.0-staging.10",
      "0.6.0",
      "0.6.1",
    ]);
  });
});

describe("isVersionCompatible", () => {
  test("same major.minor are compatible", () => {
    expect(isVersionCompatible("1.2.3", "1.2.5")).toBe(true);
  });

  test("different minor are incompatible", () => {
    expect(isVersionCompatible("1.2.3", "1.3.0")).toBe(false);
  });

  test("different major are incompatible", () => {
    expect(isVersionCompatible("1.2.3", "2.2.3")).toBe(false);
  });

  test("pre-release on same major.minor is compatible", () => {
    expect(isVersionCompatible("0.6.0-staging.5", "0.6.0")).toBe(true);
  });

  test("returns false for unparseable input", () => {
    expect(isVersionCompatible("bad", "1.0.0")).toBe(false);
  });
});
