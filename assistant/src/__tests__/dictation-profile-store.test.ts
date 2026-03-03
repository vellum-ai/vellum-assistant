import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  loadConfig,
  resetCache,
  resolveProfile,
  setStorePathOverride,
} from "../daemon/dictation-profile-store.js";

let testDir: string;
let testFilePath: string;

beforeEach(() => {
  testDir = join(
    tmpdir(),
    `vellum-test-profiles-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(testDir, { recursive: true });
  testFilePath = join(testDir, "dictation-profiles.json");
  setStorePathOverride(testFilePath);
});

afterEach(() => {
  setStorePathOverride(null);
  try {
    rmSync(testDir, { recursive: true, force: true });
  } catch {}
});

function writeConfig(config: unknown): void {
  writeFileSync(testFilePath, JSON.stringify(config, null, 2));
}

describe("loadConfig", () => {
  test("returns default config when file is missing or malformed", () => {
    // Missing file
    let config = loadConfig();
    expect(config.profiles).toHaveLength(1);
    expect(config.profiles[0].id).toBe("general");

    // Malformed JSON
    resetCache();
    writeFileSync(testFilePath, "not json");
    config = loadConfig();
    expect(config.profiles[0].id).toBe("general");
  });

  test("loads valid config from disk", () => {
    writeConfig({
      version: 1,
      defaultProfileId: "work",
      profiles: [
        { id: "work", name: "Work", stylePrompt: "Be professional" },
        { id: "casual", name: "Casual" },
      ],
    });
    const config = loadConfig();
    expect(config.profiles).toHaveLength(2);
    expect(config.defaultProfileId).toBe("work");
  });

  test("enforces validation limits", () => {
    writeConfig({
      version: 1,
      profiles: [
        {
          id: "test",
          name: "Test",
          stylePrompt: "x".repeat(3000),
          dictionary: [
            { spoken: "ok", written: "okay" },
            { spoken: "x".repeat(201), written: "bad" },
          ],
          snippets: [
            { trigger: "brb", expansion: "be right back" },
            { trigger: "good", expansion: "y".repeat(5001) },
          ],
        },
      ],
    });
    const config = loadConfig();
    expect(config.profiles[0].stylePrompt!.length).toBe(2000);
    expect(config.profiles[0].dictionary).toHaveLength(1);
    expect(config.profiles[0].snippets).toHaveLength(1);
  });
});

describe("resolveProfile", () => {
  test("resolution precedence: request > app_mapping > default > fallback", () => {
    writeConfig({
      version: 1,
      defaultProfileId: "default-one",
      appMappings: [{ profileId: "mapped", bundleIdentifier: "com.test.app" }],
      profiles: [
        { id: "requested", name: "Requested" },
        { id: "mapped", name: "Mapped" },
        { id: "default-one", name: "Default" },
      ],
    });

    // Explicit request wins
    expect(resolveProfile("com.test.app", "Test", "requested").source).toBe(
      "request",
    );

    // App mapping next
    expect(resolveProfile("com.test.app", "Test").source).toBe("app_mapping");

    // Default when no mapping
    expect(resolveProfile("com.other.app", "Other").source).toBe("default");

    // Fallback when nothing configured
    resetCache();
    writeConfig({ version: 1, profiles: [{ id: "unused", name: "Unused" }] });
    expect(resolveProfile("com.other.app", "Other").source).toBe("fallback");
  });

  test("bundleIdentifier match beats appName match", () => {
    writeConfig({
      version: 1,
      appMappings: [
        { profileId: "by-name", appName: "Slack" },
        {
          profileId: "by-bundle",
          bundleIdentifier: "com.tinyspeck.slackmacgap",
        },
      ],
      profiles: [
        { id: "by-name", name: "By Name" },
        { id: "by-bundle", name: "By Bundle" },
      ],
    });
    expect(
      resolveProfile("com.tinyspeck.slackmacgap", "Slack").profile.id,
    ).toBe("by-bundle");
  });

  test("skips disabled profiles", () => {
    writeConfig({
      version: 1,
      defaultProfileId: "disabled",
      profiles: [{ id: "disabled", name: "Disabled", enabled: false }],
    });
    const result = resolveProfile("com.test.app", "Test", "disabled");
    expect(result.profile.id).toBe("general");
    expect(result.source).toBe("fallback");
  });
});
