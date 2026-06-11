import { describe, expect, test } from "bun:test";

import { resolveLocalUpgradeTarget } from "../local-upgrade.js";

describe("resolveLocalUpgradeTarget", () => {
  test("null requested version resolves to the CLI's own tag", () => {
    expect(resolveLocalUpgradeTarget(null, "0.8.10")).toEqual({
      ok: true,
      tag: "v0.8.10",
    });
  });

  test("matching version with v prefix is accepted", () => {
    expect(resolveLocalUpgradeTarget("v0.8.10", "0.8.10")).toEqual({
      ok: true,
      tag: "v0.8.10",
    });
  });

  test("matching version without v prefix is accepted", () => {
    expect(resolveLocalUpgradeTarget("0.8.10", "0.8.10")).toEqual({
      ok: true,
      tag: "v0.8.10",
    });
  });

  test("older explicit version is rejected with --latest guidance", () => {
    const result = resolveLocalUpgradeTarget("v0.0.1", "0.8.10");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("v0.8.10");
      expect(result.reason).toContain("v0.0.1");
      expect(result.reason).toContain("--latest");
    }
  });

  test("newer explicit version is rejected with --latest guidance", () => {
    const result = resolveLocalUpgradeTarget("v9.9.9", "0.8.10");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("--latest");
    }
  });
});
