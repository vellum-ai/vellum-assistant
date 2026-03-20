import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must precede the migration import
// ---------------------------------------------------------------------------

mock.module("../security/secure-keys.js", () => ({
  getProviderKeyAsync: async () => null,
  getSecureKeyAsync: async () => ({ value: undefined, unreachable: false }),
}));

import { servicesConfigMigration } from "../workspace/migrations/006-services-config.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): void {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-006-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
}

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("006-services-config migration", () => {
  test("migrates all legacy fields into services object", async () => {
    writeConfig({
      provider: "openai",
      model: "gpt-4o",
      imageGenModel: "dall-e-3",
      webSearchProvider: "brave",
      otherSetting: true,
    });

    await servicesConfigMigration.run(workspaceDir);

    const config = readConfig();

    // Legacy fields removed
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
    expect(config.imageGenModel).toBeUndefined();
    expect(config.webSearchProvider).toBeUndefined();

    // Non-legacy fields preserved
    expect(config.otherSetting).toBe(true);

    // Services populated correctly
    const services = config.services as Record<string, Record<string, unknown>>;
    expect(services.inference).toEqual({
      mode: "your-own",
      provider: "openai",
      model: "gpt-4o",
    });
    expect(services["image-generation"]).toEqual({
      mode: "your-own",
      provider: "openai",
      model: "dall-e-3",
    });
    expect(services["web-search"]).toEqual({
      mode: "your-own",
      provider: "brave",
    });
  });

  test("uses anthropic defaults when legacy fields are non-string", async () => {
    // Legacy fields present but not strings (e.g. null or number) — fall
    // through to defaults
    writeConfig({
      provider: null,
      model: 123,
    });

    await servicesConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;
    expect(services.inference.provider).toBe("anthropic");
    expect(services.inference.model).toBe("claude-opus-4-6");
  });

  test("no-op when config.json does not exist", async () => {
    // No config file — should return without error
    await servicesConfigMigration.run(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when no legacy fields are present (fresh install)", async () => {
    const original = {
      services: {
        inference: {
          mode: "your-own",
          provider: "anthropic",
          model: "claude-opus-4-6",
        },
      },
    };
    writeConfig(original);

    await servicesConfigMigration.run(workspaceDir);

    // Config should be unchanged — migration skipped entirely
    const config = readConfig();
    expect(config).toEqual(original);
  });

  test("no-op when no legacy fields are present (already migrated)", async () => {
    const alreadyMigrated = {
      services: {
        inference: { mode: "your-own", provider: "openai", model: "gpt-4o" },
        "image-generation": {
          mode: "your-own",
          provider: "gemini",
          model: "gemini-2.5-flash-image",
        },
        "web-search": { mode: "your-own", provider: "anthropic-native" },
      },
    };
    writeConfig(alreadyMigrated);

    await servicesConfigMigration.run(workspaceDir);

    const config = readConfig();
    expect(config).toEqual(alreadyMigrated);
  });

  test("idempotency: running migration twice produces same result", async () => {
    writeConfig({
      provider: "openai",
      model: "gpt-4o",
      imageGenModel: "dall-e-3",
      webSearchProvider: "brave",
    });

    await servicesConfigMigration.run(workspaceDir);
    const afterFirst = readConfig();

    await servicesConfigMigration.run(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("merges with existing backfilled services object", async () => {
    // Simulates the scenario where backfillConfigDefaults wrote a default
    // services object before migrations run, and legacy fields coexist.
    writeConfig({
      provider: "openai",
      model: "gpt-4o",
      services: {
        inference: {
          mode: "your-own",
          provider: "anthropic",
          model: "claude-opus-4-6",
        },
        "image-generation": {
          mode: "your-own",
          provider: "gemini",
          model: "gemini-2.5-flash-image",
        },
        "web-search": {
          mode: "your-own",
          provider: "anthropic-native",
        },
      },
    });

    await servicesConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;

    // Legacy fields should win over backfilled defaults
    expect(services.inference.provider).toBe("openai");
    expect(services.inference.model).toBe("gpt-4o");

    // Legacy fields removed
    expect(config.provider).toBeUndefined();
    expect(config.model).toBeUndefined();
  });

  test("preserves extra keys from existing services during merge", async () => {
    // If backfill or future code added extra keys in services, the spread
    // operator should preserve them.
    writeConfig({
      provider: "openai",
      services: {
        inference: {
          mode: "your-own",
          provider: "anthropic",
          model: "claude-opus-4-6",
          extraKey: "should-survive",
        },
        "custom-service": {
          foo: "bar",
        },
      },
    });

    await servicesConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;

    // Extra key preserved from spread
    expect(services.inference.extraKey).toBe("should-survive");

    // Custom service section preserved from top-level spread
    expect(services["custom-service"]).toEqual({ foo: "bar" });
  });

  test("gemini image model sets provider to gemini", async () => {
    writeConfig({
      imageGenModel: "gemini-2.5-flash-image",
    });

    await servicesConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;
    expect(services["image-generation"].provider).toBe("gemini");
    expect(services["image-generation"].model).toBe("gemini-2.5-flash-image");
  });

  test("dall-e image model sets provider to openai", async () => {
    writeConfig({
      imageGenModel: "dall-e-3",
    });

    await servicesConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;
    expect(services["image-generation"].provider).toBe("openai");
    expect(services["image-generation"].model).toBe("dall-e-3");
  });

  test("gracefully handles invalid JSON in config file", async () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");

    // Should return without error
    await servicesConfigMigration.run(workspaceDir);

    // File should be unchanged
    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("gracefully handles array config", async () => {
    writeFileSync(join(workspaceDir, "config.json"), JSON.stringify([1, 2, 3]));

    // Should return without error
    await servicesConfigMigration.run(workspaceDir);

    // File should be unchanged
    const raw = JSON.parse(
      readFileSync(join(workspaceDir, "config.json"), "utf-8"),
    );
    expect(raw).toEqual([1, 2, 3]);
  });

  test("falls back to existing services values when legacy fields are absent for that service", async () => {
    // Only provider legacy field present; imageGenModel and webSearchProvider
    // are missing. Existing services should be used for image-generation and
    // web-search.
    writeConfig({
      provider: "openai",
      services: {
        "image-generation": {
          mode: "your-own",
          provider: "openai",
          model: "dall-e-2",
        },
        "web-search": {
          mode: "your-own",
          provider: "brave",
        },
      },
    });

    await servicesConfigMigration.run(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;

    // image-generation: falls back to existing services model value
    expect(services["image-generation"].model).toBe("dall-e-2");
    expect(services["image-generation"].provider).toBe("openai");

    // web-search: falls back to existing services provider value
    expect(services["web-search"].provider).toBe("brave");
  });
});
