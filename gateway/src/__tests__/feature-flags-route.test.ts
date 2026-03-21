import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  rmSync,
  existsSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Use an isolated temp directory so tests don't touch the real workspace config
const testDir = join(
  tmpdir(),
  `vellum-ff-test-${randomBytes(6).toString("hex")}`,
);
const vellumRoot = join(testDir, ".vellum");
const protectedDir = join(vellumRoot, "protected");
const featureFlagStorePath = join(protectedDir, "feature-flags.json");

// Write the test registry to an isolated temp path so we never touch
// the committed gateway/src/feature-flag-registry.json file.
const defaultsPath = join(testDir, "feature-flag-registry.json");

const TEST_REGISTRY = {
  version: 1,
  flags: [
    {
      id: "browser",
      scope: "assistant",
      key: "feature_flags.browser.enabled",
      label: "Browser",
      description: "Browser skill",
      defaultEnabled: true,
    },
    {
      id: "contacts",
      scope: "assistant",
      key: "feature_flags.contacts.enabled",
      label: "Contacts",
      description: "Contacts management",
      defaultEnabled: false,
    },
    {
      id: "user-hosted-enabled",
      scope: "macos",
      key: "user_hosted_enabled",
      label: "User Hosted Enabled",
      description: "Enable user-hosted onboarding flow",
      defaultEnabled: false,
    },
  ],
};

const savedBaseDataDir = process.env.BASE_DATA_DIR;

beforeEach(() => {
  process.env.BASE_DATA_DIR = testDir;
  mkdirSync(protectedDir, { recursive: true });
  writeFileSync(defaultsPath, JSON.stringify(TEST_REGISTRY, null, 2));
  // Point registry resolution at the isolated test file first
  _setRegistryCandidateOverrides([defaultsPath]);
  resetFeatureFlagDefaultsCache();
  clearFeatureFlagStoreCache();
});

afterEach(() => {
  if (savedBaseDataDir === undefined) {
    delete process.env.BASE_DATA_DIR;
  } else {
    process.env.BASE_DATA_DIR = savedBaseDataDir;
  }
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {
    // best effort cleanup
  }
  // Clear the test-only candidate override and reset the defaults cache
  _setRegistryCandidateOverrides(null);
  resetFeatureFlagDefaultsCache();
  clearFeatureFlagStoreCache();
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

    // Should return all declared assistant-scope flags (not macos-scope)
    expect(body.flags.length).toBe(declaredKeys.length);
    expect(body.flags.length).toBeGreaterThan(0);

    // Each entry should have the expected shape including label
    for (const flag of body.flags) {
      expect(typeof flag.key).toBe("string");
      expect(typeof flag.label).toBe("string");
      expect(typeof flag.enabled).toBe("boolean");
      expect(typeof flag.defaultEnabled).toBe("boolean");
      expect(typeof flag.description).toBe("string");
      expect(flag.key).toMatch(
        /^feature_flags\.[a-z0-9][a-z0-9._-]*\.enabled$/,
      );
    }

    // Check a specific known flag
    const browserFlag = body.flags.find(
      (f: { key: string }) => f.key === "feature_flags.browser.enabled",
    );
    expect(browserFlag).toBeDefined();
    expect(browserFlag.defaultEnabled).toBe(true);
    expect(browserFlag.label).toBe("Browser");
    // When no persisted value, enabled should equal defaultEnabled
    expect(browserFlag.enabled).toBe(true);
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
      (f: { key: string }) => f.key === "feature_flags.browser.enabled",
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

    // The macos-scope flag should not appear
    const macosFlag = body.flags.find(
      (f: { key: string }) => f.key === "user_hosted_enabled",
    );
    expect(macosFlag).toBeUndefined();
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
          "feature_flags.browser.enabled": false,
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
      (f: { key: string }) => f.key === "feature_flags.browser.enabled",
    );
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(false); // overridden from default true
    expect(browserFlag.defaultEnabled).toBe(true);
  });

  test("ignores non-boolean values in persisted feature flags", async () => {
    // Write a feature-flags.json with an invalid non-boolean value manually
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: {
          "feature_flags.browser.enabled": "no",
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

    // readPersistedFeatureFlags filters out non-boolean values, so the
    // invalid "no" string is dropped and the flag falls back to its
    // registry default (true).
    const browserFlag = body.flags.find(
      (f: { key: string }) => f.key === "feature_flags.browser.enabled",
    );
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(true);
    expect(browserFlag.defaultEnabled).toBe(true);
  });
});

describe("PATCH /v1/feature-flags/:flagKey handler", () => {
  test("writes to feature-flags.json store", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request(
        "http://gateway.test/v1/feature-flags/feature_flags.browser.enabled",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      ),
      "feature_flags.browser.enabled",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({
      key: "feature_flags.browser.enabled",
      enabled: false,
    });

    // Verify persistence to the feature-flags.json store
    clearFeatureFlagStoreCache();
    const persisted = readPersistedFeatureFlags();
    expect(persisted["feature_flags.browser.enabled"]).toBe(false);
  });

  test("preserves existing persisted flags when writing", async () => {
    // Pre-seed a flag value
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: {
          "feature_flags.contacts.enabled": true,
        },
      }),
    );
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsPatchHandler();
    await handler(
      new Request(
        "http://gateway.test/v1/feature-flags/feature_flags.browser.enabled",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      ),
      "feature_flags.browser.enabled",
    );

    // Both old and new values should be persisted
    clearFeatureFlagStoreCache();
    const persisted = readPersistedFeatureFlags();
    expect(persisted["feature_flags.contacts.enabled"]).toBe(true);
    expect(persisted["feature_flags.browser.enabled"]).toBe(true);
  });

  test("creates feature-flags.json and directories when they do not exist", async () => {
    // Remove the protected dir to test directory creation
    rmSync(protectedDir, { recursive: true, force: true });

    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request(
        "http://gateway.test/v1/feature-flags/feature_flags.browser.enabled",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      ),
      "feature_flags.browser.enabled",
    );

    expect(res.status).toBe(200);
    expect(existsSync(featureFlagStorePath)).toBe(true);

    clearFeatureFlagStoreCache();
    const persisted = readPersistedFeatureFlags();
    expect(persisted["feature_flags.browser.enabled"]).toBe(true);
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

  test("rejects key not matching feature_flags.<id>.enabled format", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const invalidKeys = [
      "random.key",
      "feature_flags.enabled",
      "feature_flags..enabled",
      "feature_flags.UPPERCASE.enabled",
      "feature_flags.browser.disabled",
      "other.browser.enabled",
      "feature_flags.browser.enabled.extra",
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
      new Request(
        "http://gateway.test/v1/feature-flags/feature_flags.totally-unknown-flag.enabled",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: true }),
        },
      ),
      "feature_flags.totally-unknown-flag.enabled",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not declared");
  });

  test("accepts valid declared feature_flags.* key formats", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const validKeys = [
      "feature_flags.browser.enabled",
      "feature_flags.contacts.enabled",
    ];

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

  test("rejects non-boolean enabled value", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const invalidValues = ["true", 1, null, undefined];
    for (const value of invalidValues) {
      const res = await handler(
        new Request(
          "http://gateway.test/v1/feature-flags/feature_flags.browser.enabled",
          {
            method: "PATCH",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ enabled: value }),
          },
        ),
        "feature_flags.browser.enabled",
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("boolean");
    }
  });

  test("rejects invalid JSON body", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request(
        "http://gateway.test/v1/feature-flags/feature_flags.browser.enabled",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: "not json",
        },
      ),
      "feature_flags.browser.enabled",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("valid JSON");
  });

  test("rejects missing body", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request(
        "http://gateway.test/v1/feature-flags/feature_flags.browser.enabled",
        {
          method: "PATCH",
        },
      ),
      "feature_flags.browser.enabled",
    );

    expect(res.status).toBe(400);
  });

  test("atomic write does not corrupt store on successful write", async () => {
    // Pre-seed the store
    writeFileSync(
      featureFlagStorePath,
      JSON.stringify({
        version: 1,
        values: { "feature_flags.contacts.enabled": true },
      }),
    );
    clearFeatureFlagStoreCache();

    const handler = createFeatureFlagsPatchHandler();
    await handler(
      new Request(
        "http://gateway.test/v1/feature-flags/feature_flags.browser.enabled",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: false }),
        },
      ),
      "feature_flags.browser.enabled",
    );

    // Verify the file is valid JSON and contains all expected data
    const raw = readFileSync(featureFlagStorePath, "utf-8");
    const data = JSON.parse(raw);
    expect(data.version).toBe(1);
    expect(data.values["feature_flags.contacts.enabled"]).toBe(true);
    expect(data.values["feature_flags.browser.enabled"]).toBe(false);

    // Verify no temp files left behind
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(protectedDir);
    const tmpFiles = files.filter((f: string) => f.includes(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });

  test("concurrent writes are serialized and no flag change is lost", async () => {
    const handler = createFeatureFlagsPatchHandler();

    // Fire multiple concurrent PATCH requests at the same time
    const flagKeys = [
      "feature_flags.browser.enabled",
      "feature_flags.contacts.enabled",
    ];

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
});
