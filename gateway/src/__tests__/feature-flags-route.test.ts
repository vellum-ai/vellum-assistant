import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  rmSync,
  mkdirSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { testSecurityDir } from "./test-preload.js";

const protectedDir = testSecurityDir;
const featureFlagStorePath = join(protectedDir, "feature-flags.json");
const remoteFeatureFlagStorePath = join(
  protectedDir,
  "feature-flags-remote.json",
);

// Write the test registry to an isolated temp path so we never touch
// the committed gateway/src/feature-flag-registry.json file.
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
      id: "user-hosted-enabled",
      scope: "client",
      key: "user-hosted-enabled",
      label: "User Hosted Enabled",
      description: "Enable user-hosted onboarding flow",
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
      // GA-normalization-exempt staged-rollout flag (defaultEnabled: true).
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
  // Point registry resolution at the isolated test file first
  _setRegistryCandidateOverrides([defaultsPath]);
  resetFeatureFlagDefaultsCache();
  clearFeatureFlagStoreCache();
  clearRemoteFeatureFlagStoreCache();
});

afterEach(() => {
  // Clean up fixture files but keep the directory for the next test.
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
  delete process.env.VELLUM_FLAG_A2A_CHANNEL;
  delete process.env.IS_PLATFORM;
});

const { createFeatureFlagsGetHandler, createFeatureFlagsPatchHandler } =
  await import("../http/routes/feature-flags.js");
const {
  loadFeatureFlagDefaults,
  resetFeatureFlagDefaultsCache,
  _setRegistryCandidateOverrides,
} = await import("../feature-flag-defaults.js");
const { clearFeatureFlagStoreCache, readPersistedFeatureFlags } =
  await import("../feature-flag-store.js");
const { clearRemoteFeatureFlagStoreCache, writeRemoteFeatureFlags } =
  await import("../feature-flag-remote-store.js");
const { resetEnvOverridesCache } =
  await import("../feature-flag-env-overrides.js");

describe("GET /v1/feature-flags handler", () => {
  test("returns all declared assistant-scope flags with defaults when no persisted file exists", async () => {
    // Don't create the feature-flags.json file
    if (existsSync(featureFlagStorePath)) {
      rmSync(featureFlagStorePath);
    }

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const defaults = loadFeatureFlagDefaults();
    const declaredKeys = Object.keys(defaults);

    // Should return all declared assistant-scope flags (not client-scope)
    expect(body.flags.length).toBe(declaredKeys.length);
    expect(body.flags.length).toBeGreaterThan(0);

    // Each entry should have the expected shape including label
    for (const flag of body.flags) {
      expect(typeof flag.key).toBe("string");
      expect(typeof flag.label).toBe("string");
      expect(["boolean", "string"]).toContain(typeof flag.enabled);
      expect(["boolean", "string"]).toContain(typeof flag.defaultEnabled);
      expect(typeof flag.description).toBe("string");
      expect(flag.key).toMatch(/^[a-z0-9][a-z0-9-]*$/);
    }

    // Check a specific known flag
    const browserFlag = body.flags.find(
      (f: { key: string }) => f.key === "browser",
    );
    expect(browserFlag).toBeDefined();
    expect(browserFlag.defaultEnabled).toBe(true);
    expect(browserFlag.label).toBe("Browser");
    // When no persisted value, enabled should equal defaultEnabled
    expect(browserFlag.enabled).toBe(true);
  });

  test("reports a staged-rollout flag as disabled on managed when absent (matches the daemon IPC map)", async () => {
    // messages-search-backend defaults true in the registry but is a
    // GA-normalization-exempt staged-rollout flag. On a managed deployment
    // (IS_PLATFORM) with no persisted/remote value, the HTTP list served to the
    // web client must report it disabled — same as getMergedFeatureFlags — so
    // the settings UI does not diverge from the value driving search. browser
    // (GA, not exempt) stays enabled.
    process.env.IS_PLATFORM = "true";
    if (existsSync(featureFlagStorePath)) rmSync(featureFlagStorePath);
    clearFeatureFlagStoreCache();
    clearRemoteFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const msearch = body.flags.find(
      (f: { key: string }) => f.key === "messages-search-backend",
    );
    expect(msearch.enabled).toBe(false);
    // The displayed registry default still reflects the true registry value.
    expect(msearch.defaultEnabled).toBe(true);
    const browser = body.flags.find(
      (f: { key: string }) => f.key === "browser",
    );
    expect(browser.enabled).toBe(true);
  });

  test("returns label field for all flags", async () => {
    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    for (const flag of body.flags) {
      expect(typeof flag.label).toBe("string");
      expect(flag.label.length).toBeGreaterThan(0);
    }

    // Verify specific labels
    const browserFlag2 = body.flags.find(
      (f: { key: string }) => f.key === "browser",
    );
    expect(browserFlag2).toBeDefined();
    expect(browserFlag2.label).toBe("Browser");
  });

  test("does not include non-assistant-scope flags", async () => {
    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // The client-scope flag should not appear
    const clientFlag = body.flags.find(
      (f: { key: string }) => f.key === "user-hosted-enabled",
    );
    expect(clientFlag).toBeUndefined();
  });

  test("returns all declared flags even when store has no persisted values", async () => {
    // Write an empty feature-flags.json store
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({ version: 1, values: {} }),
    );
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    const defaults = loadFeatureFlagDefaults();
    const declaredKeys = Object.keys(defaults);

    expect(body.flags.length).toBe(declaredKeys.length);
  });

  test("merges persisted values from feature-flags.json with defaults", async () => {
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: {
          browser: false,
        },
      }),
    );
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const browserFlag = body.flags.find(
      (f: { key: string }) => f.key === "browser",
    );
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(false); // overridden from default true
    expect(browserFlag.defaultEnabled).toBe(true);
  });

  test("accepts string values in persisted feature flags", async () => {
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: {
          "default-model": "gpt-4",
        },
      }),
    );
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const modelFlag = body.flags.find(
      (f: { key: string }) => f.key === "default-model",
    );
    expect(modelFlag).toBeDefined();
    expect(modelFlag.enabled).toBe("gpt-4");
    expect(modelFlag.defaultEnabled).toBe("claude-sonnet-4-6");
  });

  test("ignores non-boolean non-string values in persisted feature flags", async () => {
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: {
          browser: 42,
        },
      }),
    );
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const browserFlag = body.flags.find(
      (f: { key: string }) => f.key === "browser",
    );
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(true);
    expect(browserFlag.defaultEnabled).toBe(true);
  });

  test("remote values fill in when no local override exists", async () => {
    // Write a remote store with a2a-channel enabled (overriding registry default of false)
    writeFileSync(
      remoteFeatureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: {
          "a2a-channel": true,
        },
      }),
    );
    clearRemoteFeatureFlagStoreCache();

    // No local override for a2a-channel
    if (existsSync(featureFlagStorePath)) {
      rmSync(featureFlagStorePath);
    }
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const a2aFlag = body.flags.find(
      (f: { key: string }) => f.key === "a2a-channel",
    );
    expect(a2aFlag).toBeDefined();
    // Remote value (true) overrides registry default (false)
    expect(a2aFlag.enabled).toBe(true);
  });

  test("local overrides take precedence over remote values", async () => {
    // Set remote value to true
    writeFileSync(
      remoteFeatureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: {
          "a2a-channel": true,
        },
      }),
    );
    clearRemoteFeatureFlagStoreCache();

    // Set local override to false
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: {
          "a2a-channel": false,
        },
      }),
    );
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const a2aFlag = body.flags.find(
      (f: { key: string }) => f.key === "a2a-channel",
    );
    expect(a2aFlag).toBeDefined();
    // Local override (false) takes precedence over remote (true)
    expect(a2aFlag.enabled).toBe(false);
  });

  test("reflects updated flags after remote sync writes new values (stale cache regression)", async () => {
    // Scenario: the remote poller (RemoteFeatureFlagSync) writes
    // a2a-channel: false, the gateway caches it, then a subsequent
    // poll writes a2a-channel: true. The GET handler should return
    // the updated value because writeRemoteFeatureFlags() updates
    // both disk and the in-memory cache.

    // Step 1: First poll writes a2a-channel: false (simulated via
    // writeRemoteFeatureFlags, which is what the poller calls internally).
    writeRemoteFeatureFlags({ "a2a-channel": false });

    const handler = createFeatureFlagsGetHandler();
    const res1 = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );
    const body1 = await res1.json();
    const a2aFlag1 = body1.flags.find(
      (f: { key: string }) => f.key === "a2a-channel",
    );
    expect(a2aFlag1.enabled).toBe(false);

    // Step 2: Second poll writes a2a-channel: true — the poller
    // calls writeRemoteFeatureFlags which updates file + cache.
    writeRemoteFeatureFlags({ "a2a-channel": true });

    // Step 3: The GET handler should immediately reflect the update
    // without needing a file-watcher round-trip.
    const res2 = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );
    const body2 = await res2.json();
    const a2aFlag2 = body2.flags.find(
      (f: { key: string }) => f.key === "a2a-channel",
    );
    expect(a2aFlag2.enabled).toBe(true);
  });

  test("registry default used when neither local nor remote is set", async () => {
    // No local override
    if (existsSync(featureFlagStorePath)) {
      rmSync(featureFlagStorePath);
    }
    clearFeatureFlagStoreCache();

    // No remote value (empty remote store)
    if (existsSync(remoteFeatureFlagStorePath)) {
      rmSync(remoteFeatureFlagStorePath);
    }
    clearRemoteFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // a2a-channel has defaultEnabled: false in registry
    const a2aFlag = body.flags.find(
      (f: { key: string }) => f.key === "a2a-channel",
    );
    expect(a2aFlag).toBeDefined();
    expect(a2aFlag.enabled).toBe(false);
    expect(a2aFlag.defaultEnabled).toBe(false);

    // browser has defaultEnabled: true in registry
    const browserFlag = body.flags.find(
      (f: { key: string }) => f.key === "browser",
    );
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(true);
    expect(browserFlag.defaultEnabled).toBe(true);
  });

  test("declared flags missing from a remote snapshot use their registry defaults", async () => {
    // No local override
    if (existsSync(featureFlagStorePath)) {
      rmSync(featureFlagStorePath);
    }
    clearFeatureFlagStoreCache();

    // Remote snapshot exists, but browser is absent as it would be when the
    // platform has no LaunchDarkly value for that key.
    writeFileSync(
      remoteFeatureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: { "a2a-channel": true },
      }),
    );
    clearRemoteFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const a2aFlag = body.flags.find(
      (f: { key: string }) => f.key === "a2a-channel",
    );
    expect(a2aFlag.enabled).toBe(true);

    const browserFlag = body.flags.find(
      (f: { key: string }) => f.key === "browser",
    );
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(true);
    expect(browserFlag.defaultEnabled).toBe(true);
  });

  test("string flag uses registry default when no override exists", async () => {
    if (existsSync(featureFlagStorePath)) rmSync(featureFlagStorePath);
    if (existsSync(remoteFeatureFlagStorePath))
      rmSync(remoteFeatureFlagStorePath);
    clearFeatureFlagStoreCache();
    clearRemoteFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const modelFlag = body.flags.find(
      (f: { key: string }) => f.key === "default-model",
    );
    expect(modelFlag).toBeDefined();
    expect(modelFlag.enabled).toBe("claude-sonnet-4-6");
    expect(modelFlag.defaultEnabled).toBe("claude-sonnet-4-6");
  });

  test("remote string value overrides registry default for string flag", async () => {
    writeRemoteFeatureFlags({ "default-model": "gpt-4" });
    if (existsSync(featureFlagStorePath)) rmSync(featureFlagStorePath);
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const modelFlag = body.flags.find(
      (f: { key: string }) => f.key === "default-model",
    );
    expect(modelFlag).toBeDefined();
    expect(modelFlag.enabled).toBe("gpt-4");
  });

  test("env override takes precedence over persisted and default values", async () => {
    // Persisted value sets a2a-channel to false
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: { "a2a-channel": false },
      }),
    );
    clearFeatureFlagStoreCache();

    // Env override sets it to true
    process.env.VELLUM_FLAG_A2A_CHANNEL = "true";
    resetEnvOverridesCache();

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags"),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    const a2aFlag = body.flags.find(
      (f: { key: string }) => f.key === "a2a-channel",
    );
    expect(a2aFlag).toBeDefined();
    expect(a2aFlag.enabled).toBe(true);
  });

  test("returns flags when invoked via assistants path without trailing slash", async () => {
    // The macOS client sends GET /v1/assistants/<id>/feature-flags (no trailing slash).
    // The gateway route regex must accept this path.
    const handler = createFeatureFlagsGetHandler();
    const res = await handler(
      new Request(
        "http://gateway.test/v1/assistants/some-assistant-id/feature-flags",
      ),
    );

    expect(res.status).toBe(200);
    const body = await res.json();

    // Should return all assistant-scope flags with expected shape
    expect(body.flags.length).toBeGreaterThan(0);
    for (const flag of body.flags) {
      expect(typeof flag.key).toBe("string");
      expect(["boolean", "string"]).toContain(typeof flag.enabled);
    }

    // Verify a known flag is present
    const browserFlag = body.flags.find(
      (f: { key: string }) => f.key === "browser",
    );
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(true);
  });
});

describe("PATCH /v1/feature-flags/:flagKey handler", () => {
  test("writes to feature-flags.json store", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/browser", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      "browser",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      key: "browser",
      enabled: false,
    });

    // Verify persistence to the feature-flags.json store
    clearFeatureFlagStoreCache();
    const persisted = readPersistedFeatureFlags();
    expect(persisted["browser"]).toBe(false);
  });

  test("preserves existing persisted flags when writing", async () => {
    // Pre-seed a flag value
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: {
          "a2a-channel": true,
        },
      }),
    );
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsPatchHandler();
    await handler(
      new Request("http://gateway.test/v1/feature-flags/browser", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "browser",
    );

    // Both old and new values should be persisted
    clearFeatureFlagStoreCache();
    const persisted = readPersistedFeatureFlags();
    expect(persisted["a2a-channel"]).toBe(true);
    expect(persisted["browser"]).toBe(true);
  });

  test("creates feature-flags.json and directories when they do not exist", async () => {
    // Remove the protected dir to test directory creation
    rmSync(protectedDir, { recursive: true, force: true });

    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/a2a-channel", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "a2a-channel",
    );

    expect(res.status).toBe(200);
    expect(existsSync(featureFlagStorePath)).toBe(true);

    clearFeatureFlagStoreCache();
    const persisted = readPersistedFeatureFlags();
    expect(persisted["a2a-channel"]).toBe(true);
  });

  // Validation tests
  test("rejects empty flag key", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("non-empty");
  });

  test("rejects old skills.* key format", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const oldFormatKeys = [
      "skills.browser.enabled",
      "skills.contacts.enabled",
      "skills.my-skill.enabled",
    ];

    for (const key of oldFormatKeys) {
      const res = await handler(
        new Request(`http://gateway.test/v1/feature-flags/${key}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
        key,
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid flag key format");
    }
  });

  test("rejects key not matching simple kebab-case format", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const invalidKeys = [
      "random.key",
      "UPPERCASE",
      "has_underscore",
      "has.dot",
      "INVALID!",
      "-starts-with-dash",
    ];

    for (const key of invalidKeys) {
      const res = await handler(
        new Request(`http://gateway.test/v1/feature-flags/${key}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
        key,
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("Invalid flag key format");
    }
  });

  test("rejects undeclared keys (not in defaults registry)", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/totally-unknown-flag", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "totally-unknown-flag",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not declared");
  });

  test("accepts valid declared kebab-case key formats", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const validKeys = ["browser", "a2a-channel"];

    for (const key of validKeys) {
      clearFeatureFlagStoreCache();
      const res = await handler(
        new Request(`http://gateway.test/v1/feature-flags/${key}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        }),
        key,
      );

      expect(res.status).toBe(200);
    }
  });

  test("accepts string enabled value", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/default-model", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: "gpt-4" }),
      }),
      "default-model",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ key: "default-model", enabled: "gpt-4" });

    clearFeatureFlagStoreCache();
    const persisted = readPersistedFeatureFlags();
    expect(persisted["default-model"]).toBe("gpt-4");
  });

  test("rejects non-boolean non-string enabled value", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const invalidValues = [1, null, undefined];
    for (const value of invalidValues) {
      const res = await handler(
        new Request("http://gateway.test/v1/feature-flags/browser", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: value }),
        }),
        "browser",
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("boolean or string");
    }
  });

  test("rejects invalid JSON body", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/browser", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      "browser",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("valid JSON");
  });

  test("rejects missing body", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/browser", {
        method: "PATCH",
      }),
      "browser",
    );

    expect(res.status).toBe(400);
  });

  test("atomic write does not corrupt store on successful write", async () => {
    // Pre-seed the store
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: { "a2a-channel": true },
      }),
    );
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsPatchHandler();
    await handler(
      new Request("http://gateway.test/v1/feature-flags/browser", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      "browser",
    );

    // Verify the file is valid JSON and contains all expected data
    const raw = readFileSync(featureFlagStorePath, "utf-8");
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);
    expect(data.values["a2a-channel"]).toBe(true);
    expect(data.values["browser"]).toBe(false);

    // Verify no temp files left behind
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(protectedDir);
    const tmpFiles = files.filter((f: string) => f.includes(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });

  test("concurrent writes are serialized and no flag change is lost", async () => {
    const handler = createFeatureFlagsPatchHandler();

    // Fire multiple concurrent PATCH requests at the same time
    const flagKeys = ["browser", "a2a-channel"];

    const results = await Promise.all(
      flagKeys.map((key) =>
        handler(
          new Request(`http://gateway.test/v1/feature-flags/${key}`, {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: false }),
          }),
          key,
        ),
      ),
    );

    // All should succeed
    for (const res of results) {
      expect(res.status).toBe(200);
    }

    // All flags should be persisted — none should be lost to a race
    clearFeatureFlagStoreCache();
    const persisted = readPersistedFeatureFlags();
    for (const key of flagKeys) {
      expect(persisted[key]).toBe(false);
    }
  });

  test("invokes onFlagChanged once after a successful write", async () => {
    let calls = 0;
    const handler = createFeatureFlagsPatchHandler(() => {
      calls += 1;
    });
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/browser", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      "browser",
    );

    expect(res.status).toBe(200);
    expect(calls).toBe(1);
  });

  test("does not invoke onFlagChanged when the request is rejected", async () => {
    let calls = 0;
    const handler = createFeatureFlagsPatchHandler(() => {
      calls += 1;
    });
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/totally-unknown-flag", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "totally-unknown-flag",
    );

    expect(res.status).toBe(400);
    expect(calls).toBe(0);
  });

  test("a throwing onFlagChanged does not fail an already-committed write", async () => {
    const handler = createFeatureFlagsPatchHandler(() => {
      throw new Error("notification boom");
    });
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/browser", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      "browser",
    );

    expect(res.status).toBe(200);

    clearFeatureFlagStoreCache();
    const persisted = readPersistedFeatureFlags();
    expect(persisted["browser"]).toBe(false);
  });
});
