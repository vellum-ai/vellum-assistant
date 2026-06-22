import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testSecurityDir } from "./__tests__/test-preload.js";

const protectedDir = testSecurityDir;
const defaultsPath = join(protectedDir, "feature-flag-registry.json");

const TEST_REGISTRY = {
  version: 1,
  flags: [
    {
      id: "auto-analyze",
      scope: "assistant",
      key: "auto-analyze",
      label: "Auto Analyze",
      description: "Automatic analysis",
      defaultEnabled: false,
    },
    {
      id: "cool-feature",
      scope: "assistant",
      key: "cool-feature",
      label: "Cool Feature",
      description: "A cool feature",
      defaultEnabled: false,
    },
  ],
};

const { readEnvFeatureFlagOverrides, resetEnvOverridesCache } = await import(
  "./feature-flag-env-overrides.js"
);
const { resetFeatureFlagDefaultsCache, _setRegistryCandidateOverrides } =
  await import("./feature-flag-defaults.js");

/** Keys set by tests, cleaned up automatically. */
const injectedKeys: string[] = [];

function setEnv(key: string, value: string): void {
  process.env[key] = value;
  injectedKeys.push(key);
}

beforeEach(() => {
  mkdirSync(protectedDir, { recursive: true });
  writeFileSync(defaultsPath, JSON.stringify(TEST_REGISTRY, null, 2));
  _setRegistryCandidateOverrides([defaultsPath]);
  resetFeatureFlagDefaultsCache();
  resetEnvOverridesCache();
});

afterEach(() => {
  for (const key of injectedKeys) {
    delete process.env[key];
  }
  injectedKeys.length = 0;

  try {
    rmSync(protectedDir, { recursive: true, force: true });
    mkdirSync(protectedDir, { recursive: true });
  } catch {
    // best-effort cleanup
  }
  _setRegistryCandidateOverrides(null);
  resetFeatureFlagDefaultsCache();
  resetEnvOverridesCache();
});

describe("readEnvFeatureFlagOverrides", () => {
  test("maps VELLUM_FLAG_AUTO_ANALYZE=true to { 'auto-analyze': true }", () => {
    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "true");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": true });
  });

  test("parses truthy values: 1, yes, on -> true", () => {
    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "1");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": true });

    resetEnvOverridesCache();
    delete process.env.VELLUM_FLAG_AUTO_ANALYZE;

    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "yes");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": true });

    resetEnvOverridesCache();
    delete process.env.VELLUM_FLAG_AUTO_ANALYZE;

    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "on");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": true });
  });

  test("parses falsy values: false, 0, no, off -> false", () => {
    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "false");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": false });

    resetEnvOverridesCache();
    delete process.env.VELLUM_FLAG_AUTO_ANALYZE;

    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "0");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": false });

    resetEnvOverridesCache();
    delete process.env.VELLUM_FLAG_AUTO_ANALYZE;

    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "no");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": false });

    resetEnvOverridesCache();
    delete process.env.VELLUM_FLAG_AUTO_ANALYZE;

    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "off");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": false });
  });

  test("preserves arbitrary string values", () => {
    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "some-custom-value");
    expect(readEnvFeatureFlagOverrides()).toEqual({
      "auto-analyze": "some-custom-value",
    });
  });

  test("discards unknown keys not in registry", () => {
    setEnv("VELLUM_FLAG_NONEXISTENT_FLAG", "true");
    expect(readEnvFeatureFlagOverrides()).toEqual({});
  });

  test("caches result across calls", () => {
    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "true");
    const first = readEnvFeatureFlagOverrides();
    expect(first).toEqual({ "auto-analyze": true });

    // Mutate env after first call
    setEnv("VELLUM_FLAG_COOL_FEATURE", "true");
    const second = readEnvFeatureFlagOverrides();
    expect(second).toEqual({ "auto-analyze": true });
    expect(second).toBe(first);
  });

  test("resetEnvOverridesCache allows re-read", () => {
    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "true");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": true });

    setEnv("VELLUM_FLAG_COOL_FEATURE", "true");
    resetEnvOverridesCache();
    expect(readEnvFeatureFlagOverrides()).toEqual({
      "auto-analyze": true,
      "cool-feature": true,
    });
  });

  test("returns empty object when no VELLUM_FLAG_* keys exist", () => {
    expect(readEnvFeatureFlagOverrides()).toEqual({});
  });

  test("value parsing is case-insensitive", () => {
    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "TRUE");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": true });

    resetEnvOverridesCache();
    delete process.env.VELLUM_FLAG_AUTO_ANALYZE;

    setEnv("VELLUM_FLAG_AUTO_ANALYZE", "False");
    expect(readEnvFeatureFlagOverrides()).toEqual({ "auto-analyze": false });
  });
});
