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
});

const { createFeatureFlagsGetHandler, createFeatureFlagsPatchHandler } = await import(
  "../http/routes/feature-flags.js"
);

describe("GET /v1/feature-flags handler", () => {
  test("returns empty flags array when config file does not exist", async () => {
    // Don't create the config file
    if (existsSync(configPath)) {
      rmSync(configPath);
    }

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toEqual([]);
  });

  test("returns empty flags array when config has no featureFlags key", async () => {
    writeFileSync(configPath, JSON.stringify({ sms: { phoneNumber: "+1234" } }));

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toEqual([]);
  });

  test("returns stored feature flags", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        featureFlags: {
          "skills.browser.enabled": true,
          "skills.twitter.enabled": false,
        },
      }),
    );

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toEqual([
      { key: "skills.browser.enabled", enabled: true },
      { key: "skills.twitter.enabled", enabled: false },
    ]);
  });

  test("ignores non-boolean values in featureFlags", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        featureFlags: {
          "skills.browser.enabled": true,
          "skills.bad.enabled": "yes",
          "skills.number.enabled": 1,
        },
      }),
    );

    const handler = createFeatureFlagsGetHandler();
    const res = await handler(new Request("http://gateway.test/v1/feature-flags"));

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.flags).toEqual([{ key: "skills.browser.enabled", enabled: true }]);
  });
});

describe("PATCH /v1/feature-flags/:flagKey handler", () => {
  test("creates a new feature flag", async () => {
    writeFileSync(configPath, JSON.stringify({}));

    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/skills.browser.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "skills.browser.enabled",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ key: "skills.browser.enabled", enabled: true });

    // Verify persistence
    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.featureFlags["skills.browser.enabled"]).toBe(true);
  });

  test("updates an existing feature flag", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        featureFlags: { "skills.browser.enabled": true },
      }),
    );

    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/skills.browser.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      "skills.browser.enabled",
    );

    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ key: "skills.browser.enabled", enabled: false });

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.featureFlags["skills.browser.enabled"]).toBe(false);
  });

  test("preserves unknown config keys when writing", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({
        sms: { phoneNumber: "+1234567890" },
        email: { address: "test@example.com" },
        featureFlags: { "skills.existing.enabled": true },
      }),
    );

    const handler = createFeatureFlagsPatchHandler();
    await handler(
      new Request("http://gateway.test/v1/feature-flags/skills.new.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "skills.new.enabled",
    );

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.sms).toEqual({ phoneNumber: "+1234567890" });
    expect(config.email).toEqual({ address: "test@example.com" });
    expect(config.featureFlags["skills.existing.enabled"]).toBe(true);
    expect(config.featureFlags["skills.new.enabled"]).toBe(true);
  });

  test("creates config file and directories when they do not exist", async () => {
    // Remove the workspace dir to test directory creation
    rmSync(workspaceDir, { recursive: true, force: true });

    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/skills.test.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: true }),
      }),
      "skills.test.enabled",
    );

    expect(res.status).toBe(200);
    expect(existsSync(configPath)).toBe(true);

    const config = JSON.parse(readFileSync(configPath, "utf-8"));
    expect(config.featureFlags["skills.test.enabled"]).toBe(true);
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

  test("rejects key not matching skills.<id>.enabled format", async () => {
    const handler = createFeatureFlagsPatchHandler();

    const invalidKeys = [
      "random.key",
      "skills.enabled",
      "skills..enabled",
      "skills.UPPERCASE.enabled",
      "skills.browser.disabled",
      "other.browser.enabled",
      "skills.browser.enabled.extra",
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

  test("accepts valid skill key formats", async () => {
    writeFileSync(configPath, JSON.stringify({}));
    const handler = createFeatureFlagsPatchHandler();

    const validKeys = [
      "skills.browser.enabled",
      "skills.twitter.enabled",
      "skills.my-skill.enabled",
      "skills.my_skill.enabled",
      "skills.skill123.enabled",
      "skills.my.dotted.skill.enabled",
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
        new Request("http://gateway.test/v1/feature-flags/skills.test.enabled", {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ enabled: value }),
        }),
        "skills.test.enabled",
      );

      expect(res.status).toBe(400);
      const body = await res.json();
      expect(body.error).toContain("boolean");
    }
  });

  test("rejects invalid JSON body", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/skills.test.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "not json",
      }),
      "skills.test.enabled",
    );

    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toContain("valid JSON");
  });

  test("rejects missing body", async () => {
    const handler = createFeatureFlagsPatchHandler();
    const res = await handler(
      new Request("http://gateway.test/v1/feature-flags/skills.test.enabled", {
        method: "PATCH",
      }),
      "skills.test.enabled",
    );

    expect(res.status).toBe(400);
  });

  test("atomic write does not corrupt config on successful write", async () => {
    // Write initial config
    const initial = {
      sms: { phoneNumber: "+1234" },
      featureFlags: { "skills.a.enabled": true },
    };
    writeFileSync(configPath, JSON.stringify(initial));

    const handler = createFeatureFlagsPatchHandler();
    await handler(
      new Request("http://gateway.test/v1/feature-flags/skills.b.enabled", {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ enabled: false }),
      }),
      "skills.b.enabled",
    );

    // Verify the file is valid JSON and contains all expected data
    const raw = readFileSync(configPath, "utf-8");
    const config = JSON.parse(raw);
    expect(config.sms).toEqual({ phoneNumber: "+1234" });
    expect(config.featureFlags["skills.a.enabled"]).toBe(true);
    expect(config.featureFlags["skills.b.enabled"]).toBe(false);

    // Verify no temp files left behind
    const { readdirSync } = await import("node:fs");
    const files = readdirSync(workspaceDir);
    const tmpFiles = files.filter((f: string) => f.endsWith(".tmp"));
    expect(tmpFiles.length).toBe(0);
  });
});
