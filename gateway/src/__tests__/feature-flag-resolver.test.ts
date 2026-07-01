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
    {
      id: "default-model",
      scope: "assistant",
      key: "default-model",
      label: "Default Model",
      description: "Default LLM model identifier",
      defaultEnabled: "claude-sonnet-4-6",
    },
    {
      id: "empty-string-flag",
      scope: "assistant",
      key: "empty-string-flag",
      label: "Empty String Flag",
      description: "A string flag with empty default",
      defaultEnabled: "",
    },
    {
      // GA-normalization-exempt staged-rollout flag (defaultEnabled: true, but
      // listed in GA_NORMALIZATION_EXEMPT_FLAGS). On managed deployments an
      // absent value must fail safe to false rather than the true default.
      id: "messages-search-backend",
      scope: "assistant",
      key: "messages-search-backend",
      label: "Messages Search Backend",
      description: "Messages search backend (qdrant default; staged rollout)",
      defaultEnabled: true,
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
  resetEnvOverridesCache();
  delete process.env.VELLUM_FLAG_BROWSER;
  delete process.env.VELLUM_FLAG_A2A_CHANNEL;
  delete process.env.VELLUM_FLAG_DEFAULT_MODEL;
  delete process.env.IS_PLATFORM;
});

const { isFeatureFlagEnabled, getFeatureFlagValue } =
  await import("../feature-flag-resolver.js");
const { resetFeatureFlagDefaultsCache, _setRegistryCandidateOverrides } =
  await import("../feature-flag-defaults.js");
const { clearFeatureFlagStoreCache, writeFeatureFlag } =
  await import("../feature-flag-store.js");
const { clearRemoteFeatureFlagStoreCache, writeRemoteFeatureFlags } =
  await import("../feature-flag-remote-store.js");
const { resetEnvOverridesCache } =
  await import("../feature-flag-env-overrides.js");

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

  test("coerces non-empty string to true", () => {
    expect(isFeatureFlagEnabled("default-model")).toBe(true);
  });

  test("coerces empty string to false", () => {
    expect(isFeatureFlagEnabled("empty-string-flag")).toBe(false);
  });

  test("coerces persisted string override to true", () => {
    writeFeatureFlag("empty-string-flag", "overridden");
    expect(isFeatureFlagEnabled("empty-string-flag")).toBe(true);
  });
});

describe("getFeatureFlagValue", () => {
  test("returns string default for string flags", () => {
    expect(getFeatureFlagValue("default-model")).toBe("claude-sonnet-4-6");
    expect(getFeatureFlagValue("empty-string-flag")).toBe("");
  });

  test("returns boolean default for boolean flags", () => {
    expect(getFeatureFlagValue("browser")).toBe(true);
    expect(getFeatureFlagValue("a2a-channel")).toBe(false);
  });

  test("returns false for undeclared flags", () => {
    expect(getFeatureFlagValue("nonexistent")).toBe(false);
  });

  test("persisted string value overrides default", () => {
    writeFeatureFlag("default-model", "gpt-4");
    expect(getFeatureFlagValue("default-model")).toBe("gpt-4");
  });

  test("remote string value overrides default when no persisted value", () => {
    writeRemoteFeatureFlags({ "default-model": "gpt-4" });
    expect(getFeatureFlagValue("default-model")).toBe("gpt-4");
  });

  test("persisted takes precedence over remote for string flags", () => {
    writeRemoteFeatureFlags({ "default-model": "remote-model" });
    writeFeatureFlag("default-model", "persisted-model");
    expect(getFeatureFlagValue("default-model")).toBe("persisted-model");
  });

  test("env override wins over persisted, remote, and default values", () => {
    writeRemoteFeatureFlags({ browser: false });
    writeFeatureFlag("browser", false);

    process.env.VELLUM_FLAG_BROWSER = "true";
    resetEnvOverridesCache();

    expect(getFeatureFlagValue("browser")).toBe(true);
  });

  test("env override wins for string flags", () => {
    writeRemoteFeatureFlags({ "default-model": "remote-model" });
    writeFeatureFlag("default-model", "persisted-model");

    process.env.VELLUM_FLAG_DEFAULT_MODEL = "env-model";
    resetEnvOverridesCache();

    expect(getFeatureFlagValue("default-model")).toBe("env-model");
  });
});

describe("getFeatureFlagValue · staged-rollout (GA-normalization-exempt) flags", () => {
  test("absent value falls back to the registry default on non-managed installs", () => {
    // No IS_PLATFORM: local/self-hosted resolves the true registry default.
    expect(getFeatureFlagValue("messages-search-backend")).toBe(true);
  });

  test("absent value fails safe to false on a managed deployment", () => {
    // On managed (IS_PLATFORM=true), an absent value must NOT opt in via the
    // true registry default — it fails safe to false until LD supplies a value.
    // Covers: deployed before platform provisioning, stale/empty remote cache,
    // or a failed first fetch.
    process.env.IS_PLATFORM = "true";
    expect(getFeatureFlagValue("messages-search-backend")).toBe(false);
  });

  test("explicit remote value is honored on a managed deployment", () => {
    // Once LD targeting supplies an explicit value it wins over the fail-safe.
    process.env.IS_PLATFORM = "true";
    writeRemoteFeatureFlags({ "messages-search-backend": true });
    expect(getFeatureFlagValue("messages-search-backend")).toBe(true);
  });

  test("explicit remote false is honored on a managed deployment", () => {
    process.env.IS_PLATFORM = "true";
    writeRemoteFeatureFlags({ "messages-search-backend": false });
    expect(getFeatureFlagValue("messages-search-backend")).toBe(false);
  });

  test("persisted override is honored on a managed deployment", () => {
    process.env.IS_PLATFORM = "true";
    writeFeatureFlag("messages-search-backend", true);
    expect(getFeatureFlagValue("messages-search-backend")).toBe(true);
  });

  test("a non-exempt GA flag still uses its true default on a managed deployment", () => {
    // The managed fail-safe applies only to exempt flags — browser (GA, not
    // exempt) must keep its true default even on managed with no explicit value.
    process.env.IS_PLATFORM = "true";
    expect(getFeatureFlagValue("browser")).toBe(true);
  });
});
