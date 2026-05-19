import { describe, expect, test } from "bun:test";

import { compareParsed, comparePreRelease, parseSemver } from "@/lib/semver.js";

// MARK: - parseSemver

describe("parseSemver", () => {
  test("parses simple version", () => {
    expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
  });

  test("parses version with v prefix", () => {
    expect(parseSemver("v1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
  });

  test("parses version with V prefix", () => {
    expect(parseSemver("V1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: null });
  });

  test("parses pre-release suffix", () => {
    expect(parseSemver("1.2.3-staging.5")).toEqual({ major: 1, minor: 2, patch: 3, pre: "staging.5" });
  });

  test("parses pre-release with v prefix", () => {
    expect(parseSemver("v0.6.0-staging.1")).toEqual({ major: 0, minor: 6, patch: 0, pre: "staging.1" });
  });

  test("preserves multiple hyphens in pre-release", () => {
    expect(parseSemver("1.0.0-alpha-beta.1")).toEqual({ major: 1, minor: 0, patch: 0, pre: "alpha-beta.1" });
  });

  test("returns null for empty string", () => {
    expect(parseSemver("")).toBeNull();
  });

  test("returns null for bare v", () => {
    expect(parseSemver("v")).toBeNull();
  });

  test("returns null for garbage", () => {
    expect(parseSemver("not-a-version")).toBeNull();
  });

  test("returns null for two-component version", () => {
    expect(parseSemver("1.2")).toBeNull();
  });

  test("returns null for single number", () => {
    expect(parseSemver("42")).toBeNull();
  });
});

// MARK: - comparePreRelease

describe("comparePreRelease", () => {
  test("equal identifiers return 0", () => {
    expect(comparePreRelease("staging.5", "staging.5")).toBe(0);
  });

  test("numeric identifiers compared as integers", () => {
    expect(comparePreRelease("staging.1", "staging.2")).toBeLessThan(0);
    expect(comparePreRelease("staging.2", "staging.1")).toBeGreaterThan(0);
  });

  test("numeric comparison not lexical (9 < 10)", () => {
    expect(comparePreRelease("staging.9", "staging.10")).toBeLessThan(0);
  });

  test("lexical comparison for non-numeric identifiers", () => {
    expect(comparePreRelease("alpha", "beta")).toBeLessThan(0);
    expect(comparePreRelease("beta", "alpha")).toBeGreaterThan(0);
  });

  test("numeric sorts lower than non-numeric (§11.4.4)", () => {
    expect(comparePreRelease("1", "alpha")).toBeLessThan(0);
    expect(comparePreRelease("alpha", "1")).toBeGreaterThan(0);
  });

  test("fewer identifiers sort earlier", () => {
    expect(comparePreRelease("alpha", "alpha.1")).toBeLessThan(0);
    expect(comparePreRelease("alpha.1", "alpha")).toBeGreaterThan(0);
  });

  test("multi-level comparison", () => {
    expect(comparePreRelease("alpha.1.2", "alpha.1.3")).toBeLessThan(0);
  });
});

// MARK: - compareParsed

describe("compareParsed", () => {
  test("compares by major version", () => {
    const a = { major: 1, minor: 0, patch: 0, pre: null };
    const b = { major: 2, minor: 0, patch: 0, pre: null };
    expect(compareParsed(a, b)).toBeLessThan(0);
    expect(compareParsed(b, a)).toBeGreaterThan(0);
  });

  test("compares by minor version", () => {
    const a = { major: 1, minor: 2, patch: 0, pre: null };
    const b = { major: 1, minor: 3, patch: 0, pre: null };
    expect(compareParsed(a, b)).toBeLessThan(0);
  });

  test("compares by patch version", () => {
    const a = { major: 1, minor: 2, patch: 3, pre: null };
    const b = { major: 1, minor: 2, patch: 4, pre: null };
    expect(compareParsed(a, b)).toBeLessThan(0);
  });

  test("equal versions return 0", () => {
    const a = { major: 1, minor: 2, patch: 3, pre: null };
    const b = { major: 1, minor: 2, patch: 3, pre: null };
    expect(compareParsed(a, b)).toBe(0);
  });

  test("pre-release is less than release", () => {
    const pre = { major: 1, minor: 2, patch: 3, pre: "staging.5" };
    const rel = { major: 1, minor: 2, patch: 3, pre: null };
    expect(compareParsed(pre, rel)).toBeLessThan(0);
    expect(compareParsed(rel, pre)).toBeGreaterThan(0);
  });

  test("staging version less than release (real-world case)", () => {
    const staging = parseSemver("0.6.0-staging.5")!;
    const release = parseSemver("0.6.0")!;
    expect(compareParsed(staging, release)).toBeLessThan(0);
  });

  test("staging.1 less than staging.2", () => {
    const a = parseSemver("0.6.0-staging.1")!;
    const b = parseSemver("0.6.0-staging.2")!;
    expect(compareParsed(a, b)).toBeLessThan(0);
  });

  test("both nil pre-release returns 0", () => {
    const a = { major: 1, minor: 0, patch: 0, pre: null };
    const b = { major: 1, minor: 0, patch: 0, pre: null };
    expect(compareParsed(a, b)).toBe(0);
  });

  test("different pre-release same core", () => {
    const a = { major: 1, minor: 0, patch: 0, pre: "alpha" };
    const b = { major: 1, minor: 0, patch: 0, pre: "beta" };
    expect(compareParsed(a, b)).toBeLessThan(0);
  });
});
