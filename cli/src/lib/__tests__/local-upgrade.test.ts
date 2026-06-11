import { describe, expect, test } from "bun:test";

import {
  checkLocalVersionDirection,
  resolveLocalProbeUrl,
  resolveLocalUpgradeTarget,
} from "../local-upgrade.js";

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

describe("checkLocalVersionDirection", () => {
  test("downgrade (running runtime newer than CLI) is rejected", () => {
    const result = checkLocalVersionDirection("v0.8.10", "v0.9.0");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toContain("v0.9.0");
      expect(result.reason).toContain("v0.8.10");
      expect(result.reason).toContain("vellum upgrade --latest");
      expect(result.reason).not.toContain("rollback");
    }
  });

  test("equal versions are allowed", () => {
    expect(checkLocalVersionDirection("v0.8.10", "v0.8.10")).toEqual({
      ok: true,
    });
  });

  test("newer target is allowed", () => {
    expect(checkLocalVersionDirection("v0.9.0", "v0.8.10")).toEqual({
      ok: true,
    });
  });

  test("unknown current version proceeds with a warning (Docker parity)", () => {
    const result = checkLocalVersionDirection("v0.8.10", undefined);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.warning).toContain("skipping version-direction check");
    }
  });

  test("unparseable current version proceeds without warning (Docker parity)", () => {
    expect(checkLocalVersionDirection("v0.8.10", "not-a-version")).toEqual({
      ok: true,
    });
  });
});

describe("resolveLocalProbeUrl", () => {
  test("prefers localUrl when present", () => {
    expect(
      resolveLocalProbeUrl({
        localUrl: "http://127.0.0.1:18300",
        runtimeUrl: "https://my-assistant.example.com",
      }),
    ).toBe("http://127.0.0.1:18300");
  });

  test("falls back to runtimeUrl when localUrl is absent", () => {
    expect(
      resolveLocalProbeUrl({ runtimeUrl: "http://127.0.0.1:18300" }),
    ).toBe("http://127.0.0.1:18300");
  });
});
