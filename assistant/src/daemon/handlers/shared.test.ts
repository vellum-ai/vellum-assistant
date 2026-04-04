import { describe, expect, test } from "bun:test";

import { compareSemver } from "./shared.js";

describe("compareSemver", () => {
  // ── Basic numeric comparison ──────────────────────────────────────
  test("equal versions return 0", () => {
    expect(compareSemver("1.2.3", "1.2.3")).toBe(0);
  });

  test("higher major returns positive", () => {
    expect(compareSemver("2.0.0", "1.0.0")).toBeGreaterThan(0);
  });

  test("lower major returns negative", () => {
    expect(compareSemver("1.0.0", "2.0.0")).toBeLessThan(0);
  });

  test("higher minor returns positive", () => {
    expect(compareSemver("1.3.0", "1.2.0")).toBeGreaterThan(0);
  });

  test("higher patch returns positive", () => {
    expect(compareSemver("1.2.4", "1.2.3")).toBeGreaterThan(0);
  });

  // ── v/V prefix handling ───────────────────────────────────────────
  test("strips v prefix", () => {
    expect(compareSemver("v1.2.3", "1.2.3")).toBe(0);
  });

  test("strips V prefix", () => {
    expect(compareSemver("V1.2.3", "1.2.3")).toBe(0);
  });

  test("compares with mixed v prefix", () => {
    expect(compareSemver("v2.0.0", "1.0.0")).toBeGreaterThan(0);
  });

  // ── Pre-release vs release ────────────────────────────────────────
  test("pre-release sorts lower than release", () => {
    expect(compareSemver("0.6.0-staging.1", "0.6.0")).toBeLessThan(0);
  });

  test("release sorts higher than pre-release", () => {
    expect(compareSemver("0.6.0", "0.6.0-staging.1")).toBeGreaterThan(0);
  });

  test("both without pre-release and same version return 0", () => {
    expect(compareSemver("0.6.0", "0.6.0")).toBe(0);
  });

  // ── Pre-release numeric comparison ────────────────────────────────
  test("staging.1 < staging.2", () => {
    expect(compareSemver("0.6.0-staging.1", "0.6.0-staging.2")).toBeLessThan(0);
  });

  test("staging.10 > staging.2 (numeric, not lexical)", () => {
    expect(
      compareSemver("0.6.0-staging.10", "0.6.0-staging.2"),
    ).toBeGreaterThan(0);
  });

  test("equal pre-release returns 0", () => {
    expect(compareSemver("0.6.0-staging.5", "0.6.0-staging.5")).toBe(0);
  });

  // ── Pre-release lexical comparison ────────────────────────────────
  test("alpha < beta (lexical)", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBeLessThan(0);
  });

  test("rc < staging (lexical)", () => {
    expect(compareSemver("1.0.0-rc", "1.0.0-staging")).toBeLessThan(0);
  });

  // ── Pre-release fewer identifiers sorts earlier ───────────────────
  test("fewer pre-release identifiers sorts earlier", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBeLessThan(0);
  });

  // ── Mixed numeric vs non-numeric per §11.4.4 ─────────────────────
  test("numeric identifier sorts lower than non-numeric", () => {
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBeLessThan(0);
  });

  test("non-numeric identifier sorts higher than numeric", () => {
    expect(compareSemver("1.0.0-alpha", "1.0.0-1")).toBeGreaterThan(0);
  });

  // ── Multi-segment pre-release ─────────────────────────────────────
  test("multi-segment pre-release comparison", () => {
    expect(
      compareSemver("1.0.0-alpha.beta.1", "1.0.0-alpha.beta.2"),
    ).toBeLessThan(0);
  });

  // ── Hyphenated pre-release identifiers ────────────────────────────
  test("pre-release with multiple hyphens", () => {
    expect(
      compareSemver("1.0.0-pre-release-1", "1.0.0-pre-release-2"),
    ).toBeLessThan(0);
  });

  // ── Different major.minor.patch trumps pre-release ────────────────
  test("higher patch wins regardless of pre-release", () => {
    expect(compareSemver("0.6.1", "0.6.0-staging.99")).toBeGreaterThan(0);
  });

  test("lower patch loses regardless of pre-release absence", () => {
    expect(compareSemver("0.5.9", "0.6.0-staging.1")).toBeLessThan(0);
  });

  // ── Edge cases ────────────────────────────────────────────────────
  test("missing segments default to 0", () => {
    expect(compareSemver("1", "1.0.0")).toBe(0);
  });

  test("two-segment version", () => {
    expect(compareSemver("1.2", "1.2.0")).toBe(0);
  });

  // ── Sort integration ──────────────────────────────────────────────
  test("Array.sort produces correct semver order", () => {
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
