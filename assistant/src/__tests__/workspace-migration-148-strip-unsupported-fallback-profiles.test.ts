import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { renameCollidingBackupProfileNamesMigration } from "../workspace/migrations/147-rename-colliding-backup-profile-names.js";
import { stripUnsupportedFallbackProfilesMigration } from "../workspace/migrations/148-strip-unsupported-fallback-profiles.js";
import { WORKSPACE_MIGRATIONS } from "../workspace/migrations/registry.js";
import { assertNotLiveDb } from "./assert-not-live-db.js";

let workspaceDir: string;

function writeConfig(data: Record<string, unknown>): void {
  writeFileSync(
    join(workspaceDir, "config.json"),
    JSON.stringify(data, null, 2) + "\n",
  );
}

function readConfig(): Record<string, any> {
  return JSON.parse(readFileSync(join(workspaceDir, "config.json"), "utf-8"));
}

beforeEach(() => {
  workspaceDir = join(
    tmpdir(),
    `vellum-migration-148-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(workspaceDir, { recursive: true });
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    assertNotLiveDb(workspaceDir);
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

describe("148-strip-unsupported-fallback-profiles migration", () => {
  test("has the next migration id and is registered", () => {
    expect(stripUnsupportedFallbackProfilesMigration.id).toBe(
      "148-strip-unsupported-fallback-profiles",
    );
    expect(WORKSPACE_MIGRATIONS.map((migration) => migration.id)).toContain(
      "148-strip-unsupported-fallback-profiles",
    );
  });

  test("cleans a legacy pointer after migration 147 rewrites its target", async () => {
    writeConfig({
      llm: {
        profiles: {
          "balanced-backup": {
            source: "user",
            provider: "anthropic",
            model: "legacy-model",
          },
          custom: {
            source: "user",
            fallbackProfile: "balanced-backup",
          },
        },
      },
    });

    await renameCollidingBackupProfileNamesMigration.run(workspaceDir);
    expect(readConfig().llm.profiles.custom.fallbackProfile).toBe(
      "balanced-backup-custom",
    );

    stripUnsupportedFallbackProfilesMigration.run(workspaceDir);
    expect(readConfig().llm.profiles.custom.fallbackProfile).toBeUndefined();

    const once = readConfig();
    stripUnsupportedFallbackProfilesMigration.run(workspaceDir);
    expect(readConfig()).toEqual(once);
  });

  test("removes every custom pointer and preserves exact managed defaults", () => {
    writeConfig({
      llm: {
        profiles: {
          balanced: {
            source: "managed",
            fallbackProfile: "balanced-backup",
          },
          "quality-optimized": {
            source: "managed",
            fallbackProfile: "custom-backup",
          },
          custom: {
            source: "user",
            fallbackProfile: "other-custom",
          },
          "managed-custom": {
            source: "managed",
            fallbackProfile: "balanced-backup",
          },
          cleared: {
            source: "user",
            fallbackProfile: null,
          },
          untouched: { source: "user", model: "custom-model" },
        },
      },
    });

    stripUnsupportedFallbackProfilesMigration.run(workspaceDir);

    const profiles = readConfig().llm.profiles;
    expect(profiles.balanced.fallbackProfile).toBe("balanced-backup");
    expect(profiles["quality-optimized"].fallbackProfile).toBeUndefined();
    expect(profiles.custom.fallbackProfile).toBeUndefined();
    expect(profiles["managed-custom"].fallbackProfile).toBeUndefined();
    expect(profiles.cleared.fallbackProfile).toBeUndefined();
    expect(profiles.untouched).toEqual({
      source: "user",
      model: "custom-model",
    });
  });

  test.each(["openai", "chatgpt"] as const)(
    "strips managed pointers when backups do not resolve under %s",
    (provider) => {
      writeConfig({
        llm: {
          defaultProvider: { provider },
          profiles: {
            balanced: {
              source: "managed",
              fallbackProfile: "balanced-backup",
            },
            "quality-optimized": {
              source: "managed",
              fallbackProfile: "quality-optimized-backup",
            },
          },
        },
      });

      stripUnsupportedFallbackProfilesMigration.run(workspaceDir);

      const profiles = readConfig().llm.profiles;
      expect(profiles.balanced.fallbackProfile).toBeUndefined();
      expect(profiles["quality-optimized"].fallbackProfile).toBeUndefined();
    },
  );

  test("handles missing config, missing profiles, and invalid JSON", () => {
    stripUnsupportedFallbackProfilesMigration.run(workspaceDir);

    writeConfig({ theme: "dark" });
    stripUnsupportedFallbackProfilesMigration.run(workspaceDir);
    expect(readConfig()).toEqual({ theme: "dark" });

    writeFileSync(join(workspaceDir, "config.json"), "{not json");
    expect(() =>
      stripUnsupportedFallbackProfilesMigration.run(workspaceDir),
    ).not.toThrow();
  });
});
