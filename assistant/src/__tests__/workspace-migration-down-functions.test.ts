/**
 * Tests for workspace migration down() rollback functions.
 *
 * Each migration with a meaningful reverse operation is tested for:
 *  1. Correctness: down() after run() restores pre-migration state
 *  2. Idempotency: calling down() twice produces the same result
 *  3. No-op safety: down() on a workspace where run() never executed
 */

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
// Mocks — must precede all migration imports
// ---------------------------------------------------------------------------

// Mock secure-keys (used by 006-services-config)
mock.module("../security/secure-keys.js", () => ({
  getProviderKeyAsync: async () => null,
  getSecureKeyAsync: async () => null,
}));

mock.module("../security/credential-key.js", () => ({
  credentialKey: (...args: string[]) => args.join(":"),
}));

// Mock getRootDir for 016-extract-feature-flags-to-protected
let mockRootDir: string = "/tmp/mock-root";
mock.module("../util/platform.js", () => ({
  getRootDir: () => mockRootDir,
  getDataDir: () => join(mockRootDir, "workspace", "data"),
  getWorkspaceDir: () => join(mockRootDir, "workspace"),
}));

// ---------------------------------------------------------------------------
// Imports — after mocking
// ---------------------------------------------------------------------------

import { avatarRenameMigration } from "../workspace/migrations/001-avatar-rename.js";
import { extractCollectUsageDataMigration } from "../workspace/migrations/004-extract-collect-usage-data.js";
import { servicesConfigMigration } from "../workspace/migrations/006-services-config.js";
import { webSearchProviderRenameMigration } from "../workspace/migrations/007-web-search-provider-rename.js";
import { appDirRenameMigration } from "../workspace/migrations/010-app-dir-rename.js";
import { renameConversationDiskViewDirsMigration } from "../workspace/migrations/012-rename-conversation-disk-view-dirs.js";
import { extractFeatureFlagsToProtectedMigration } from "../workspace/migrations/016-extract-feature-flags-to-protected.js";
import { seedPersonaDirsMigration } from "../workspace/migrations/017-seed-persona-dirs.js";
import { migrateToWorkspaceVolumeMigration } from "../workspace/migrations/migrate-to-workspace-volume.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let workspaceDir: string;

function freshWorkspace(): string {
  const dir = join(
    tmpdir(),
    `vellum-migration-down-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(dir, { recursive: true });
  return dir;
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
  workspaceDir = freshWorkspace();
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
  // Clean up any mock root dir created for feature-flags tests
  if (existsSync(mockRootDir)) {
    rmSync(mockRootDir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 001-avatar-rename down()
// ---------------------------------------------------------------------------

describe("001-avatar-rename down()", () => {
  test("renames files back to old names after run()", () => {
    const avatarDir = join(workspaceDir, "data", "avatar");
    mkdirSync(avatarDir, { recursive: true });

    // Set up pre-migration state: old file names
    writeFileSync(join(avatarDir, "custom-avatar.png"), "image-data");
    writeFileSync(
      join(avatarDir, "avatar-components.json"),
      '{"traits": true}',
    );

    // Run forward migration
    avatarRenameMigration.run(workspaceDir);

    // Verify forward migration worked
    expect(existsSync(join(avatarDir, "avatar-image.png"))).toBe(true);
    expect(existsSync(join(avatarDir, "character-traits.json"))).toBe(true);
    expect(existsSync(join(avatarDir, "custom-avatar.png"))).toBe(false);
    expect(existsSync(join(avatarDir, "avatar-components.json"))).toBe(false);

    // Run down() to reverse
    avatarRenameMigration.down!(workspaceDir);

    // Verify reversal
    expect(existsSync(join(avatarDir, "custom-avatar.png"))).toBe(true);
    expect(existsSync(join(avatarDir, "avatar-components.json"))).toBe(true);
    expect(existsSync(join(avatarDir, "avatar-image.png"))).toBe(false);
    expect(existsSync(join(avatarDir, "character-traits.json"))).toBe(false);

    // Verify content preserved
    expect(readFileSync(join(avatarDir, "custom-avatar.png"), "utf-8")).toBe(
      "image-data",
    );
    expect(
      readFileSync(join(avatarDir, "avatar-components.json"), "utf-8"),
    ).toBe('{"traits": true}');
  });

  test("idempotent: calling down() twice produces same result", () => {
    const avatarDir = join(workspaceDir, "data", "avatar");
    mkdirSync(avatarDir, { recursive: true });

    writeFileSync(join(avatarDir, "avatar-image.png"), "image-data");
    writeFileSync(join(avatarDir, "character-traits.json"), '{"traits": true}');

    avatarRenameMigration.down!(workspaceDir);
    avatarRenameMigration.down!(workspaceDir);

    expect(existsSync(join(avatarDir, "custom-avatar.png"))).toBe(true);
    expect(existsSync(join(avatarDir, "avatar-components.json"))).toBe(true);
    expect(existsSync(join(avatarDir, "avatar-image.png"))).toBe(false);
    expect(existsSync(join(avatarDir, "character-traits.json"))).toBe(false);
  });

  test("no-op when forward migration never ran (no files)", () => {
    const avatarDir = join(workspaceDir, "data", "avatar");
    mkdirSync(avatarDir, { recursive: true });

    // No files exist — down() should be a no-op
    avatarRenameMigration.down!(workspaceDir);

    expect(existsSync(join(avatarDir, "custom-avatar.png"))).toBe(false);
    expect(existsSync(join(avatarDir, "avatar-image.png"))).toBe(false);
  });

  test("no-op when avatar directory does not exist", () => {
    // No avatar dir at all — should not throw
    avatarRenameMigration.down!(workspaceDir);
  });

  test("partial: only image exists in new name", () => {
    const avatarDir = join(workspaceDir, "data", "avatar");
    mkdirSync(avatarDir, { recursive: true });

    writeFileSync(join(avatarDir, "avatar-image.png"), "image-data");

    avatarRenameMigration.down!(workspaceDir);

    expect(existsSync(join(avatarDir, "custom-avatar.png"))).toBe(true);
    expect(existsSync(join(avatarDir, "avatar-image.png"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 004-extract-collect-usage-data down()
// ---------------------------------------------------------------------------

describe("004-extract-collect-usage-data down()", () => {
  test("restores collectUsageData=false back to feature flag", () => {
    writeConfig({
      collectUsageData: false,
      otherSetting: true,
    });

    extractCollectUsageDataMigration.down!(workspaceDir);

    const config = readConfig();
    expect(config.collectUsageData).toBeUndefined();
    expect(config.otherSetting).toBe(true);
    const flagValues = config.assistantFeatureFlagValues as Record<
      string,
      unknown
    >;
    expect(flagValues["feature_flags.collect-usage-data.enabled"]).toBe(false);
  });

  test("round-trip: run() then down() restores original state", () => {
    const original = {
      assistantFeatureFlagValues: {
        "feature_flags.collect-usage-data.enabled": false,
      },
      otherSetting: "hello",
    };
    writeConfig(original);

    extractCollectUsageDataMigration.run(workspaceDir);

    // After run, collectUsageData should be extracted
    const afterRun = readConfig();
    expect(afterRun.collectUsageData).toBe(false);
    expect(afterRun.assistantFeatureFlagValues).toBeUndefined();

    extractCollectUsageDataMigration.down!(workspaceDir);

    const afterDown = readConfig();
    expect(afterDown.collectUsageData).toBeUndefined();
    const flagValues = afterDown.assistantFeatureFlagValues as Record<
      string,
      unknown
    >;
    expect(flagValues["feature_flags.collect-usage-data.enabled"]).toBe(false);
    expect(afterDown.otherSetting).toBe("hello");
  });

  test("idempotent: calling down() twice produces same result", () => {
    writeConfig({ collectUsageData: false });

    extractCollectUsageDataMigration.down!(workspaceDir);
    const afterFirst = readConfig();

    extractCollectUsageDataMigration.down!(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("no-op when collectUsageData not present", () => {
    const original = { otherSetting: true };
    writeConfig(original);

    extractCollectUsageDataMigration.down!(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("no-op when config.json does not exist", () => {
    extractCollectUsageDataMigration.down!(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("merges into existing assistantFeatureFlagValues", () => {
    writeConfig({
      collectUsageData: false,
      assistantFeatureFlagValues: {
        "feature_flags.other-flag.enabled": true,
      },
    });

    extractCollectUsageDataMigration.down!(workspaceDir);

    const config = readConfig();
    const flagValues = config.assistantFeatureFlagValues as Record<
      string,
      unknown
    >;
    expect(flagValues["feature_flags.collect-usage-data.enabled"]).toBe(false);
    expect(flagValues["feature_flags.other-flag.enabled"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 006-services-config down()
// ---------------------------------------------------------------------------

describe("006-services-config down()", () => {
  test("extracts services back to top-level fields", () => {
    writeConfig({
      services: {
        inference: { mode: "your-own", provider: "openai", model: "gpt-4o" },
        "image-generation": {
          mode: "your-own",
          provider: "openai",
          model: "dall-e-3",
        },
        "web-search": { mode: "your-own", provider: "brave" },
      },
      otherSetting: true,
    });

    servicesConfigMigration.down!(workspaceDir);

    const config = readConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.imageGenModel).toBe("dall-e-3");
    expect(config.webSearchProvider).toBe("brave");
    expect(config.services).toBeUndefined();
    expect(config.otherSetting).toBe(true);
  });

  test("round-trip: run() then down() restores top-level fields", async () => {
    writeConfig({
      provider: "openai",
      model: "gpt-4o",
      imageGenModel: "dall-e-3",
      webSearchProvider: "brave",
      otherSetting: true,
    });

    await servicesConfigMigration.run(workspaceDir);

    const afterRun = readConfig();
    expect(afterRun.provider).toBeUndefined();
    expect(afterRun.services).toBeDefined();

    servicesConfigMigration.down!(workspaceDir);

    const afterDown = readConfig();
    expect(afterDown.provider).toBe("openai");
    expect(afterDown.model).toBe("gpt-4o");
    expect(afterDown.imageGenModel).toBe("dall-e-3");
    expect(afterDown.webSearchProvider).toBe("brave");
    expect(afterDown.services).toBeUndefined();
    expect(afterDown.otherSetting).toBe(true);
  });

  test("idempotent: calling down() twice produces same result", () => {
    writeConfig({
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
          provider: "inference-provider-native",
        },
      },
    });

    servicesConfigMigration.down!(workspaceDir);
    const afterFirst = readConfig();

    // Second call: services was already removed, so down() is a no-op
    servicesConfigMigration.down!(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("no-op when no services object present", () => {
    const original = { provider: "openai", model: "gpt-4o" };
    writeConfig(original);

    servicesConfigMigration.down!(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("no-op when config.json does not exist", () => {
    servicesConfigMigration.down!(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("gracefully handles invalid JSON", () => {
    writeFileSync(join(workspaceDir, "config.json"), "not-valid-json");

    servicesConfigMigration.down!(workspaceDir);

    expect(readFileSync(join(workspaceDir, "config.json"), "utf-8")).toBe(
      "not-valid-json",
    );
  });

  test("handles partial services object (only inference present)", () => {
    writeConfig({
      services: {
        inference: { mode: "your-own", provider: "openai", model: "gpt-4o" },
      },
    });

    servicesConfigMigration.down!(workspaceDir);

    const config = readConfig();
    expect(config.provider).toBe("openai");
    expect(config.model).toBe("gpt-4o");
    expect(config.imageGenModel).toBeUndefined();
    expect(config.webSearchProvider).toBeUndefined();
    expect(config.services).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 007-web-search-provider-rename down()
// ---------------------------------------------------------------------------

describe("007-web-search-provider-rename down()", () => {
  test("renames inference-provider-native back to anthropic-native", () => {
    writeConfig({
      services: {
        inference: {
          mode: "your-own",
          provider: "anthropic",
          model: "claude-opus-4-6",
        },
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    });

    webSearchProviderRenameMigration.down!(workspaceDir);

    const config = readConfig();
    const services = config.services as Record<string, Record<string, unknown>>;
    expect(services["web-search"].provider).toBe("anthropic-native");
  });

  test("round-trip: run() then down() restores original provider name", () => {
    writeConfig({
      services: {
        "web-search": { mode: "your-own", provider: "anthropic-native" },
      },
    });

    webSearchProviderRenameMigration.run(workspaceDir);

    const afterRun = readConfig();
    const svcAfterRun = afterRun.services as Record<
      string,
      Record<string, unknown>
    >;
    expect(svcAfterRun["web-search"].provider).toBe(
      "inference-provider-native",
    );

    webSearchProviderRenameMigration.down!(workspaceDir);

    const afterDown = readConfig();
    const svcAfterDown = afterDown.services as Record<
      string,
      Record<string, unknown>
    >;
    expect(svcAfterDown["web-search"].provider).toBe("anthropic-native");
  });

  test("idempotent: calling down() twice produces same result", () => {
    writeConfig({
      services: {
        "web-search": {
          mode: "your-own",
          provider: "inference-provider-native",
        },
      },
    });

    webSearchProviderRenameMigration.down!(workspaceDir);
    const afterFirst = readConfig();

    webSearchProviderRenameMigration.down!(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("no-op when provider is not inference-provider-native", () => {
    const original = {
      services: {
        "web-search": { mode: "your-own", provider: "brave" },
      },
    };
    writeConfig(original);

    webSearchProviderRenameMigration.down!(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("no-op when config.json does not exist", () => {
    webSearchProviderRenameMigration.down!(workspaceDir);
    expect(existsSync(join(workspaceDir, "config.json"))).toBe(false);
  });

  test("no-op when services or web-search is missing", () => {
    const original = { otherSetting: true };
    writeConfig(original);

    webSearchProviderRenameMigration.down!(workspaceDir);

    expect(readConfig()).toEqual(original);
  });
});

// ---------------------------------------------------------------------------
// 010-app-dir-rename down()
// ---------------------------------------------------------------------------

describe("010-app-dir-rename down()", () => {
  test("renames slugified app dirs back to UUID-based names", () => {
    const appsDir = join(workspaceDir, "data", "apps");
    mkdirSync(appsDir, { recursive: true });

    const appId = "a1b2c3d4-5678-9abc-def0-123456789abc";
    const dirName = "my-cool-app";

    // Create migrated state: slugified dir, json with dirName
    mkdirSync(join(appsDir, dirName), { recursive: true });
    writeFileSync(join(appsDir, dirName, "index.html"), "<html>app</html>");
    writeFileSync(
      join(appsDir, `${dirName}.json`),
      JSON.stringify({ id: appId, name: "My Cool App", dirName }),
    );
    writeFileSync(join(appsDir, `${dirName}.preview`), "preview-data");

    appDirRenameMigration.down!(workspaceDir);

    // UUID-based files should now exist
    expect(existsSync(join(appsDir, appId))).toBe(true);
    expect(existsSync(join(appsDir, `${appId}.json`))).toBe(true);
    expect(existsSync(join(appsDir, `${appId}.preview`))).toBe(true);

    // Slugified files should be gone
    expect(existsSync(join(appsDir, dirName))).toBe(false);
    expect(existsSync(join(appsDir, `${dirName}.json`))).toBe(false);
    expect(existsSync(join(appsDir, `${dirName}.preview`))).toBe(false);

    // JSON content should have dirName removed
    const json = JSON.parse(
      readFileSync(join(appsDir, `${appId}.json`), "utf-8"),
    );
    expect(json.id).toBe(appId);
    expect(json.name).toBe("My Cool App");
    expect(json.dirName).toBeUndefined();

    // App files should be preserved
    expect(readFileSync(join(appsDir, appId, "index.html"), "utf-8")).toBe(
      "<html>app</html>",
    );
  });

  test("idempotent: calling down() twice produces same result", () => {
    const appsDir = join(workspaceDir, "data", "apps");
    mkdirSync(appsDir, { recursive: true });

    const appId = "b2c3d4e5-6789-abcd-ef01-234567890abc";
    const dirName = "test-app";

    mkdirSync(join(appsDir, dirName), { recursive: true });
    writeFileSync(
      join(appsDir, `${dirName}.json`),
      JSON.stringify({ id: appId, name: "Test App", dirName }),
    );

    appDirRenameMigration.down!(workspaceDir);
    appDirRenameMigration.down!(workspaceDir);

    expect(existsSync(join(appsDir, appId))).toBe(true);
    expect(existsSync(join(appsDir, `${appId}.json`))).toBe(true);
    expect(existsSync(join(appsDir, dirName))).toBe(false);
  });

  test("no-op when apps directory does not exist", () => {
    appDirRenameMigration.down!(workspaceDir);
    // Should not throw
  });

  test("no-op when no JSON files exist", () => {
    const appsDir = join(workspaceDir, "data", "apps");
    mkdirSync(appsDir, { recursive: true });

    appDirRenameMigration.down!(workspaceDir);
    // Should not throw
  });

  test("handles multiple apps", () => {
    const appsDir = join(workspaceDir, "data", "apps");
    mkdirSync(appsDir, { recursive: true });

    const apps = [
      { id: "aaa-111", dirName: "first-app", name: "First App" },
      { id: "bbb-222", dirName: "second-app", name: "Second App" },
    ];

    for (const app of apps) {
      mkdirSync(join(appsDir, app.dirName), { recursive: true });
      writeFileSync(
        join(appsDir, `${app.dirName}.json`),
        JSON.stringify({ id: app.id, name: app.name, dirName: app.dirName }),
      );
    }

    appDirRenameMigration.down!(workspaceDir);

    for (const app of apps) {
      expect(existsSync(join(appsDir, app.id))).toBe(true);
      expect(existsSync(join(appsDir, `${app.id}.json`))).toBe(true);
      expect(existsSync(join(appsDir, app.dirName))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 012-rename-conversation-disk-view-dirs down()
// ---------------------------------------------------------------------------

describe("012-rename-conversation-disk-view-dirs down()", () => {
  test("renames timestamp-first dirs back to legacy id-first format", () => {
    const conversationsDir = join(workspaceDir, "conversations");
    mkdirSync(conversationsDir, { recursive: true });

    // Create new-format dir: {timestamp}_{conversationId}
    const timestamp = "2025-06-15T10-30-00.000Z";
    const convId = "conv-abc-123";
    const newName = `${timestamp}_${convId}`;
    mkdirSync(join(conversationsDir, newName));
    writeFileSync(join(conversationsDir, newName, "messages.json"), "[]");

    renameConversationDiskViewDirsMigration.down!(workspaceDir);

    const legacyName = `${convId}_${timestamp}`;
    expect(existsSync(join(conversationsDir, legacyName))).toBe(true);
    expect(existsSync(join(conversationsDir, newName))).toBe(false);

    // Content preserved
    expect(
      readFileSync(
        join(conversationsDir, legacyName, "messages.json"),
        "utf-8",
      ),
    ).toBe("[]");
  });

  test("round-trip: run() then down() restores legacy format", () => {
    const conversationsDir = join(workspaceDir, "conversations");
    mkdirSync(conversationsDir, { recursive: true });

    const timestamp = "2025-06-15T10-30-00.000Z";
    const convId = "my-conversation";
    const legacyName = `${convId}_${timestamp}`;
    mkdirSync(join(conversationsDir, legacyName));

    renameConversationDiskViewDirsMigration.run(workspaceDir);

    const newName = `${timestamp}_${convId}`;
    expect(existsSync(join(conversationsDir, newName))).toBe(true);
    expect(existsSync(join(conversationsDir, legacyName))).toBe(false);

    renameConversationDiskViewDirsMigration.down!(workspaceDir);

    expect(existsSync(join(conversationsDir, legacyName))).toBe(true);
    expect(existsSync(join(conversationsDir, newName))).toBe(false);
  });

  test("idempotent: calling down() twice produces same result", () => {
    const conversationsDir = join(workspaceDir, "conversations");
    mkdirSync(conversationsDir, { recursive: true });

    const timestamp = "2025-01-01T00-00-00.000Z";
    const convId = "test-conv";
    mkdirSync(join(conversationsDir, `${timestamp}_${convId}`));

    renameConversationDiskViewDirsMigration.down!(workspaceDir);
    renameConversationDiskViewDirsMigration.down!(workspaceDir);

    expect(existsSync(join(conversationsDir, `${convId}_${timestamp}`))).toBe(
      true,
    );
    expect(existsSync(join(conversationsDir, `${timestamp}_${convId}`))).toBe(
      false,
    );
  });

  test("no-op when conversations directory does not exist", () => {
    renameConversationDiskViewDirsMigration.down!(workspaceDir);
    // Should not throw
  });

  test("no-op when no directories match new format", () => {
    const conversationsDir = join(workspaceDir, "conversations");
    mkdirSync(conversationsDir, { recursive: true });
    mkdirSync(join(conversationsDir, "some-random-dir"));

    renameConversationDiskViewDirsMigration.down!(workspaceDir);

    expect(existsSync(join(conversationsDir, "some-random-dir"))).toBe(true);
  });

  test("handles multiple conversation directories", () => {
    const conversationsDir = join(workspaceDir, "conversations");
    mkdirSync(conversationsDir, { recursive: true });

    const entries = [
      { ts: "2025-01-01T00-00-00.000Z", id: "conv-a" },
      { ts: "2025-02-15T12-30-00.000Z", id: "conv-b" },
    ];

    for (const { ts, id } of entries) {
      mkdirSync(join(conversationsDir, `${ts}_${id}`));
    }

    renameConversationDiskViewDirsMigration.down!(workspaceDir);

    for (const { ts, id } of entries) {
      expect(existsSync(join(conversationsDir, `${id}_${ts}`))).toBe(true);
      expect(existsSync(join(conversationsDir, `${ts}_${id}`))).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 014-migrate-to-workspace-volume down()
// ---------------------------------------------------------------------------

describe("014-migrate-to-workspace-volume down()", () => {
  test("removes sentinel file", () => {
    const sentinelPath = join(workspaceDir, ".workspace-volume-migrated");
    writeFileSync(sentinelPath, new Date().toISOString());

    expect(existsSync(sentinelPath)).toBe(true);

    migrateToWorkspaceVolumeMigration.down!(workspaceDir);

    expect(existsSync(sentinelPath)).toBe(false);
  });

  test("idempotent: calling down() twice does not error", () => {
    const sentinelPath = join(workspaceDir, ".workspace-volume-migrated");
    writeFileSync(sentinelPath, new Date().toISOString());

    migrateToWorkspaceVolumeMigration.down!(workspaceDir);
    migrateToWorkspaceVolumeMigration.down!(workspaceDir);

    expect(existsSync(sentinelPath)).toBe(false);
  });

  test("no-op when sentinel file does not exist", () => {
    migrateToWorkspaceVolumeMigration.down!(workspaceDir);
    // Should not throw
    expect(existsSync(join(workspaceDir, ".workspace-volume-migrated"))).toBe(
      false,
    );
  });
});

// ---------------------------------------------------------------------------
// 016-extract-feature-flags-to-protected down()
// ---------------------------------------------------------------------------

describe("016-extract-feature-flags-to-protected down()", () => {
  beforeEach(() => {
    // Set up mock root dir for getRootDir() to point to our temp dir
    mockRootDir = freshWorkspace();
  });

  test("moves feature flags from protected dir back to config.json", () => {
    const protectedDir = join(mockRootDir, "protected");
    mkdirSync(protectedDir, { recursive: true });

    // Write feature flags to protected dir (post-run() state)
    writeFileSync(
      join(protectedDir, "feature-flags.json"),
      JSON.stringify(
        {
          version: 1,
          values: {
            "feature_flags.my-flag.enabled": true,
            "feature_flags.other-flag.enabled": false,
          },
        },
        null,
        2,
      ) + "\n",
    );

    // Write config without feature flags
    writeConfig({ otherSetting: true });

    extractFeatureFlagsToProtectedMigration.down!(workspaceDir);

    const config = readConfig();
    const flagValues = config.assistantFeatureFlagValues as Record<
      string,
      boolean
    >;
    expect(flagValues["feature_flags.my-flag.enabled"]).toBe(true);
    expect(flagValues["feature_flags.other-flag.enabled"]).toBe(false);
    expect(config.otherSetting).toBe(true);

    // Protected file should be cleaned up
    expect(existsSync(join(protectedDir, "feature-flags.json"))).toBe(false);
  });

  test("round-trip: run() then down() restores config.json", () => {
    const protectedDir = join(mockRootDir, "protected");

    writeConfig({
      assistantFeatureFlagValues: {
        "feature_flags.test-flag.enabled": false,
      },
      otherSetting: "hello",
    });

    extractFeatureFlagsToProtectedMigration.run(workspaceDir);

    // After run: feature flags should be in protected dir
    expect(existsSync(join(protectedDir, "feature-flags.json"))).toBe(true);
    const configAfterRun = readConfig();
    expect(configAfterRun.assistantFeatureFlagValues).toBeUndefined();

    extractFeatureFlagsToProtectedMigration.down!(workspaceDir);

    const configAfterDown = readConfig();
    const flagValues = configAfterDown.assistantFeatureFlagValues as Record<
      string,
      boolean
    >;
    expect(flagValues["feature_flags.test-flag.enabled"]).toBe(false);
    expect(configAfterDown.otherSetting).toBe("hello");
    expect(existsSync(join(protectedDir, "feature-flags.json"))).toBe(false);
  });

  test("idempotent: calling down() twice produces same result", () => {
    const protectedDir = join(mockRootDir, "protected");
    mkdirSync(protectedDir, { recursive: true });

    writeFileSync(
      join(protectedDir, "feature-flags.json"),
      JSON.stringify({
        version: 1,
        values: { "feature_flags.flag.enabled": true },
      }) + "\n",
    );

    writeConfig({});

    extractFeatureFlagsToProtectedMigration.down!(workspaceDir);
    const afterFirst = readConfig();

    // Second call: feature-flags.json was already deleted, so this is a no-op
    extractFeatureFlagsToProtectedMigration.down!(workspaceDir);
    const afterSecond = readConfig();

    expect(afterSecond).toEqual(afterFirst);
  });

  test("no-op when feature-flags.json does not exist in protected dir", () => {
    const original = { otherSetting: true };
    writeConfig(original);

    extractFeatureFlagsToProtectedMigration.down!(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("no-op when feature-flags.json has no values", () => {
    const protectedDir = join(mockRootDir, "protected");
    mkdirSync(protectedDir, { recursive: true });

    writeFileSync(
      join(protectedDir, "feature-flags.json"),
      JSON.stringify({ version: 1, values: {} }) + "\n",
    );

    const original = { otherSetting: true };
    writeConfig(original);

    extractFeatureFlagsToProtectedMigration.down!(workspaceDir);

    expect(readConfig()).toEqual(original);
  });

  test("merges into existing assistantFeatureFlagValues", () => {
    const protectedDir = join(mockRootDir, "protected");
    mkdirSync(protectedDir, { recursive: true });

    writeFileSync(
      join(protectedDir, "feature-flags.json"),
      JSON.stringify({
        version: 1,
        values: { "feature_flags.new-flag.enabled": true },
      }) + "\n",
    );

    writeConfig({
      assistantFeatureFlagValues: {
        "feature_flags.existing-flag.enabled": false,
      },
    });

    extractFeatureFlagsToProtectedMigration.down!(workspaceDir);

    const config = readConfig();
    const flagValues = config.assistantFeatureFlagValues as Record<
      string,
      boolean
    >;
    expect(flagValues["feature_flags.existing-flag.enabled"]).toBe(false);
    expect(flagValues["feature_flags.new-flag.enabled"]).toBe(true);
  });

  test("creates config.json if it does not exist", () => {
    const protectedDir = join(mockRootDir, "protected");
    mkdirSync(protectedDir, { recursive: true });

    writeFileSync(
      join(protectedDir, "feature-flags.json"),
      JSON.stringify({
        version: 1,
        values: { "feature_flags.flag.enabled": true },
      }) + "\n",
    );

    // No config.json exists

    extractFeatureFlagsToProtectedMigration.down!(workspaceDir);

    const config = readConfig();
    const flagValues = config.assistantFeatureFlagValues as Record<
      string,
      boolean
    >;
    expect(flagValues["feature_flags.flag.enabled"]).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 017-seed-persona-dirs down()
// ---------------------------------------------------------------------------

describe("017-seed-persona-dirs down()", () => {
  test("removes empty users/ and channels/ directories", () => {
    const usersDir = join(workspaceDir, "users");
    const channelsDir = join(workspaceDir, "channels");
    mkdirSync(usersDir, { recursive: true });
    mkdirSync(channelsDir, { recursive: true });

    seedPersonaDirsMigration.down!(workspaceDir);

    expect(existsSync(usersDir)).toBe(false);
    expect(existsSync(channelsDir)).toBe(false);
  });

  test("leaves non-empty directories in place", () => {
    const usersDir = join(workspaceDir, "users");
    const channelsDir = join(workspaceDir, "channels");
    mkdirSync(usersDir, { recursive: true });
    mkdirSync(channelsDir, { recursive: true });

    // Add content to users/ so it should not be removed
    writeFileSync(join(usersDir, "guardian.md"), "# Guardian");

    seedPersonaDirsMigration.down!(workspaceDir);

    expect(existsSync(usersDir)).toBe(true);
    expect(existsSync(channelsDir)).toBe(false);
  });

  test("idempotent: calling down() twice does not error", () => {
    const usersDir = join(workspaceDir, "users");
    const channelsDir = join(workspaceDir, "channels");
    mkdirSync(usersDir, { recursive: true });
    mkdirSync(channelsDir, { recursive: true });

    seedPersonaDirsMigration.down!(workspaceDir);
    seedPersonaDirsMigration.down!(workspaceDir);

    expect(existsSync(usersDir)).toBe(false);
    expect(existsSync(channelsDir)).toBe(false);
  });

  test("no-op when directories do not exist", () => {
    seedPersonaDirsMigration.down!(workspaceDir);
    // Should not throw
    expect(existsSync(join(workspaceDir, "users"))).toBe(false);
    expect(existsSync(join(workspaceDir, "channels"))).toBe(false);
  });

  test("handles case where only one directory exists", () => {
    const usersDir = join(workspaceDir, "users");
    mkdirSync(usersDir, { recursive: true });

    seedPersonaDirsMigration.down!(workspaceDir);

    expect(existsSync(usersDir)).toBe(false);
    expect(existsSync(join(workspaceDir, "channels"))).toBe(false);
  });
});
