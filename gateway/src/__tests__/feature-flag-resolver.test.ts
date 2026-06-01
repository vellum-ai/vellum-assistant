import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { testSecurityDir } from "./test-preload.js";

const protectedDir = testSecurityDir;
const defaultsPath = join(protectedDir, "feature-flag-registry.json");

const TEST_REGISTRY = {
  version: 1,
  flags: [
    {
      id: "browser",
      scope: "assistant",
      key: "browser",
      label: "Browser",
      description: "Browser skill",
      defaultEnabled: true,
    },
    {
      id: "a2a-channel",
      scope: "assistant",
      key: "a2a-channel",
      label: "A2A Channel",
      description: "A2A channel integration",
      defaultEnabled: false,
    },
  ],
};

beforeEach(() => {
  mkdirSync(protectedDir, { recursive: true });
  writeFileSync(defaultsPath, JSON.stringify(TEST_REGISTRY, null, 2));
  _setRegistryCandidateOverrides([defaultsPath]);
  resetFeatureFlagDefaultsCache();
  clearFeatureFlagStoreCache();
  clearRemoteFeatureFlagStoreCache();
});

afterEach(() => {
  try {
    rmSync(protectedDir, { recursive: true, force: true });
    mkdirSync(protectedDir, { recursive: true });
  } catch {
    // best effort cleanup
  }
  _setRegistryCandidateOverrides(null);
  resetFeatureFlagDefaultsCache();
  clearFeatureFlagStoreCache();
  clearRemoteFeatureFlagStoreCache();
});

const { isFeatureFlagEnabled } = await import("../feature-flag-resolver.js");
const { resetFeatureFlagDefaultsCache, _setRegistryCandidateOverrides } =
  await import("../feature-flag-defaults.js");
const { clearFeatureFlagStoreCache, writeFeatureFlag } =
  await import("../feature-flag-store.js");
const { clearRemoteFeatureFlagStoreCache, writeRemoteFeatureFlags } =
  await import("../feature-flag-remote-store.js");

describe("isFeatureFlagEnabled", () => {
  test("uses registry defaults when no override exists", () => {
    expect(isFeatureFlagEnabled("browser")).toBe(true);
    expect(isFeatureFlagEnabled("a2a-channel")).toBe(false);
  });

  test("uses persisted overrides for declared flags", () => {
    writeFeatureFlag("browser", false);
    writeFeatureFlag("a2a-channel", true);

    expect(isFeatureFlagEnabled("browser")).toBe(false);
    expect(isFeatureFlagEnabled("a2a-channel")).toBe(true);
  });

  test("uses explicit remote values for declared flags", () => {
    writeRemoteFeatureFlags({
      browser: false,
      "a2a-channel": true,
    });

    expect(isFeatureFlagEnabled("browser")).toBe(false);
    expect(isFeatureFlagEnabled("a2a-channel")).toBe(true);
  });

  test("ignores persisted and remote values for undeclared flags", () => {
    writeFeatureFlag("unknown", true);
    writeRemoteFeatureFlags({ unknown: true });

    expect(isFeatureFlagEnabled("unknown")).toBe(false);
  });
});
