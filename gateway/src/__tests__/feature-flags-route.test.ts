import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Use an isolated temp directory so tests don't touch the real workspace config
const testDir = join(tmpdir(), `vellum-ff-test-${randomBytes(6).toString("hex")}`);
const vellumRoot = join(testDir, ".vellum");
const workspaceDir = join(vellumRoot, "workspace");
const configPath = join(workspaceDir, "config.json");

const savedBaseDataDir = process.env.BASE_DATA_DIR;

beforeEach(() => {
  process.env.BASE_DATA_DIR = testDir;
  mkdirSync(workspaceDir, { recursive: true });
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
  // Reset the defaults cache so tests don't leak state
  resetFeatureFlagDefaultsCache();
});

const { createFeatureFlagsGetHandler, createFeatureFlagsPatchHandler } = await import(
  "../http/routes/feature-flags.js"
);
const { loadFeatureFlagDefaults, resetFeatureFlagDefaultsCache } = await import(
  "../feature-flag-defaults.js"
);

describe("GET /v1/feature-flags handler", () => {
  test("returns all declared flags with defaults when config file does not exist", async () => {
    // Don't create the config file
    if (existsSync(configPath)) {
      rmSync(configPath);
    }

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();
    const defaults = loadFeatureFlagDefaults();
    const declaredKeys = Object.keys(defaults);

    // Should return all declared flags
    expect(body.flags.length).toBe(declaredKeys.length);
    expect(body.flags.length).toBeGreaterThan(0);

    // Each entry should have the expected shape
    for (const flag of body.flags) {
      expect(typeof flag.key).toBe("string");
      expect(typeof flag.enabled).toBe("boolean");
      expect(typeof flag.defaultEnabled).toBe("boolean");
      expect(typeof flag.description).toBe("string");
      expect(flag.key).toMatch(/^feature_flags\.[a-z0-9][a-z0-9._-]*\.enabled$/);
    }

    // Check a specific known flag
    const browserFlag = body.flags.find((f: { key: string }) => f.key === "feature_flags.browser.enabled");
    expect(browserFlag).toBeDefined();
    expect(browserFlag.defaultEnabled).toBe(true);
    // When no persisted value, enabled should equal defaultEnabled
    expect(browserFlag.enabled).toBe(true);
  });

  test("returns all declared flags even when config has no persisted values", async () => {
    writeFileSync(configPath, JSON.stringify({ sms: { phoneNumber: "+1234" } }));

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();
    const defaults = loadFeatureFlagDefaults();
    const declaredKeys = Object.keys(defaults);

    expect(body.flags.length).toBe(declaredKeys.length);
  });

  test("merges persisted values from assistantFeatureFlagValues with defaults", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        assistantFeatureFlagValues: {
          "feature_flags.browser.enabled": false,
          "feature_flags.twitter.enabled": false,
        },
      }),
    );

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();

    const browserFlag = body.flags.find((f: { key: string }) => f.key === "feature_flags.browser.enabled");
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(false); // overridden from default true
    expect(browserFlag.defaultEnabled).toBe(true);

    const twitterFlag = body.flags.find((f: { key: string }) => f.key === "feature_flags.twitter.enabled");
    expect(twitterFlag).toBeDefined();
    expect(twitterFlag.enabled).toBe(false); // overridden from default true
  });

  test("reads legacy featureFlags section and maps old key format", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        featureFlags: {
          "skills.browser.enabled": false,
          "skills.twitter.enabled": true,
        },
      }),
    );

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();

    // Legacy skills.browser.enabled should map to feature_flags.browser.enabled
    const browserFlag = body.flags.find((f: { key: string }) => f.key === "feature_flags.browser.enabled");
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(false); // persisted as false

    const twitterFlag = body.flags.find((f: { key: string }) => f.key === "feature_flags.twitter.enabled");
    expect(twitterFlag).toBeDefined();
    expect(twitterFlag.enabled).toBe(true);
  });

  test("new assistantFeatureFlagValues overrides legacy featureFlags", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        featureFlags: {
          "skills.browser.enabled": false,
        },
        assistantFeatureFlagValues: {
          "feature_flags.browser.enabled": true,
        },
      }),
    );

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();

    const browserFlag = body.flags.find((f: { key: string }) => f.key === "feature_flags.browser.enabled");
    expect(browserFlag).toBeDefined();
    // The new section takes precedence over legacy
    expect(browserFlag.enabled).toBe(true);
  });

  test("ignores non-boolean values in legacy and new sections", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        featureFlags: {
          "skills.browser.enabled": true,
          "skills.bad.enabled": "yes",
          "skills.number.enabled": 1,
        },
        assistantFeatureFlagValues: {
          "feature_flags.twitter.enabled": "no",
        },
      }),
    );

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();

    // browser should be resolved from legacy
    const browserFlag = body.flags.find((f: { key: string }) => f.key === "feature_flags.browser.enabled");
    expect(browserFlag).toBeDefined();
    expect(browserFlag.enabled).toBe(true);

    // twitter should fall back to default since non-boolean was ignored
    const twitterFlag = body.flags.find((f: { key: string }) => f.key === "feature_flags.twitter.enabled");
    expect(twitterFlag).toBeDefined();
    expect(twitterFlag.enabled).toBe(twitterFlag.defaultEnabled);
  });
});

describe("PATCH /v1/feature-flags/:flagKey handler", () => {
  test("writes to assistantFeatureFlagValues section in config", async () => {
    writeFileSync(configPath, JSON.stringify({}));

    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/feature_flags.browser.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      "feature_flags.browser.enabled",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ key: "feature_flags.browser.enabled", enabled: false });

    // Verify persistence to the NEW section
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.assistantFeatureFlagValues["feature_flags.browser.enabled"]).toBe(false);
    // Should NOT write to the old featureFlags section
    expect(config.featureFlags).toBeUndefined();
  });

  test("preserves existing config keys when writing", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        sms: { phoneNumber: "+1234567890" },
        email: { address: "test@example.com" },
        featureFlags: { "skills.existing.enabled": true },
        assistantFeatureFlagValues: { "feature_flags.twitter.enabled": true },
      }),
    );

    const handler = createFeatureFlagsPatchHandler();
    await handler(
      new Request("http://gateway.test/v1/feature-flags/feature_flags.browser.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "feature_flags.browser.enabled",
    );

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.sms).toEqual({ phoneNumber: "+1234567890" });
    expect(config.email).toEqual({ address: "test@example.com" });
    // Legacy section should be preserved untouched
    expect(config.featureFlags["skills.existing.enabled"]).toBe(true);
    // New section should have both old and new values
    expect(config.assistantFeatureFlagValues["feature_flags.twitter.enabled"]).toBe(true);
    expect(config.assistantFeatureFlagValues["feature_flags.browser.enabled"]).toBe(true);
  });

  test("creates config file and directories when they do not exist", async () => {
    // Remove the workspace dir to test directory creation
    rmSync(workspaceDir, { recursive: true, force: true });

    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/feature_flags.browser.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "feature_flags.browser.enabled",
    );

    expect(res.status).toBe(200);
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.assistantFeatureFlagValues["feature_flags.browser.enabled"]).toBe(true);
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
      "skills.twitter.enabled",
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
    writeFileSync(configPath, JSON.stringify({}));
    const handler = createFeatureFlagsPatchHandler();

    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/feature_flags.totally-unknown-flag.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "feature_flags.totally-unknown-flag.enabled",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("not declared");
  });

  test("accepts valid declared feature_flags.* key formats", async () => {
    writeFileSync(configPath, JSON.stringify({}));
    const handler = createFeatureFlagsPatchHandler();

    const validKeys = [
      "feature_flags.browser.enabled",
      "feature_flags.twitter.enabled",
      "feature_flags.guardian-verify-setup.enabled",
      "feature_flags.hatch-new-assistant.enabled",
    ];

    for (const key of validKeys) {
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
        new Request("http://gateway.test/v1/feature-flags/feature_flags.browser.enabled", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: value }),
        }),
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
      new Request("http://gateway.test/v1/feature-flags/feature_flags.browser.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      "feature_flags.browser.enabled",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("valid JSON");
  });

  test("rejects missing body", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/feature_flags.browser.enabled", {
        method: "PATCH",
      }),
      "feature_flags.browser.enabled",
    );

    expect(res.status).toBe(400);
  });

  test("atomic write does not corrupt config on successful write", async () => {
    // Write initial config
    const initial = {
      sms: { phoneNumber: "+1234" },
      assistantFeatureFlagValues: { "feature_flags.browser.enabled": true },
    };
    writeFileSync(configPath, JSON.stringify(initial));

    const handler = createFeatureFlagsPatchHandler();
    await handler(
      new Request("http://gateway.test/v1/feature-flags/feature_flags.twitter.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      "feature_flags.twitter.enabled",
    );

    // Verify the file is valid JSON and contains all expected data
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    expect(config.sms).toEqual({ phoneNumber: "+1234" });
    expect(config.assistantFeatureFlagValues["feature_flags.browser.enabled"]).toBe(true);
    expect(config.assistantFeatureFlagValues["feature_flags.twitter.enabled"]).toBe(false);

    // Verify no temp files left behind
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(workspaceDir);
    const tmpFiles = files.filter((f: string) => f.endsWith(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });

  test("concurrent writes are serialized and no flag change is lost", async () => {
    writeFileSync(configPath, JSON.stringify({}));
    const handler = createFeatureFlagsPatchHandler();

    // Fire multiple concurrent PATCH requests at the same time
    const flagKeys = [
      "feature_flags.browser.enabled",
      "feature_flags.twitter.enabled",
      "feature_flags.guardian-verify-setup.enabled",
      "feature_flags.hatch-new-assistant.enabled",
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
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    for (const key of flagKeys) {
      expect(config.assistantFeatureFlagValues[key]).toBe(false);
    }
  });
});
