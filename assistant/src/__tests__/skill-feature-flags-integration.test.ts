/**
 * Integration tests for skill feature flag enforcement at system prompt,
 * skill_load, and session-skill-tools projection layers.
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
// Test-scoped temp directory and config state
// ---------------------------------------------------------------------------

const TEST_DIR = join(
  tmpdir(),
  `vellum-skill-flags-test-${crypto.randomUUID()}`,
);

let currentConfig: Record<string, unknown> = {
  sandbox: { enabled: false, backend: "native" },
  featureFlags: {},
};

const DECLARED_SKILL_ID = "hatch-new-assistant";
const DECLARED_FLAG_KEY = "feature_flags.hatch-new-assistant.enabled";

mock.module("../util/platform.js", () => ({
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  getWorkspaceDir: () => TEST_DIR,
  getWorkspaceConfigPath: () => join(TEST_DIR, "config.json"),
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
  getWorkspaceHooksDir: () => join(TEST_DIR, "hooks"),
  getWorkspacePromptPath: (file: string) => join(TEST_DIR, file),
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, "vellum.sock"),
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  getHooksDir: () => join(TEST_DIR, "hooks"),
  getIpcBlobDir: () => join(TEST_DIR, "ipc-blobs"),
  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => TEST_DIR,
  getInterfacesDir: () => join(TEST_DIR, "interfaces"),
  isMacOS: () => false,
  isLinux: () => false,
  isWindows: () => false,
  getPlatformName: () => "linux",
  getClipboardCommand: () => null,
  removeSocketFile: () => {},
  migratePath: () => {},
  migrateToWorkspaceLayout: () => {},
  migrateToDataLayout: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (v: string) => v,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
}));

mock.module("../config/user-reference.js", () => ({
  resolveUserReference: () => "TestUser",
  resolveUserPronouns: () => null,
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  listCredentialMetadata: () => [],
}));

const { buildSystemPrompt } = await import("../config/system-prompt.js");

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mkdirSync(TEST_DIR, { recursive: true });
  // Reset config to defaults before each test
  currentConfig = {
    sandbox: { enabled: false, backend: "native" },
    featureFlags: {},
  };
});

afterEach(() => {
  if (existsSync(TEST_DIR)) {
    rmSync(TEST_DIR, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createSkillOnDisk(
  id: string,
  name: string,
  description: string,
): void {
  const skillsDir = join(TEST_DIR, "skills");
  mkdirSync(join(skillsDir, id), { recursive: true });
  writeFileSync(
    join(skillsDir, id, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\nInstructions for ${id}.\n`,
  );
  // Ensure SKILLS.md index references the skill
  const indexPath = join(skillsDir, "SKILLS.md");
  const existing = existsSync(indexPath)
    ? readFileSync(indexPath, "utf-8")
    : "";
  writeFileSync(indexPath, existing + `- ${id}\n`);
}

// ---------------------------------------------------------------------------
// System prompt — feature flag filtering
// ---------------------------------------------------------------------------

describe("buildSystemPrompt feature flag filtering", () => {
  test("flag OFF skill does not appear in <available_skills> section", () => {
    createSkillOnDisk(
      DECLARED_SKILL_ID,
      "Hatch New Assistant",
      "Toggle hatch new assistant behavior",
    );
    createSkillOnDisk("twitter", "Twitter", "Post to X/Twitter");

    currentConfig = {
      sandbox: { enabled: false, backend: "native" },
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: false,
        "feature_flags.twitter.enabled": true,
      },
    };

    const result = buildSystemPrompt();

    // twitter is explicitly enabled, declared flagged skill is explicitly off
    expect(result).toContain('id="twitter"');
    expect(result).not.toContain(`id="${DECLARED_SKILL_ID}"`);
  });

  test("declared skills hidden when featureFlags is empty (registry defaults to false)", () => {
    createSkillOnDisk(
      DECLARED_SKILL_ID,
      "Hatch New Assistant",
      "Toggle hatch new assistant behavior",
    );
    createSkillOnDisk("twitter", "Twitter", "Post to X/Twitter");

    currentConfig = {
      sandbox: { enabled: false, backend: "native" },
      assistantFeatureFlagValues: {},
    };

    const result = buildSystemPrompt();

    // Both skills are declared in the registry with defaultEnabled: false
    expect(result).not.toContain(`id="${DECLARED_SKILL_ID}"`);
    expect(result).not.toContain('id="twitter"');
  });

  test("flagged-off skills hidden even when all workspace skill flags are OFF", () => {
    createSkillOnDisk(
      DECLARED_SKILL_ID,
      "Hatch New Assistant",
      "Toggle hatch new assistant behavior",
    );
    createSkillOnDisk("twitter", "Twitter", "Post to X/Twitter");

    currentConfig = {
      sandbox: { enabled: false, backend: "native" },
      assistantFeatureFlagValues: {
        [DECLARED_FLAG_KEY]: false,
        "feature_flags.twitter.enabled": false,
      },
    };

    const result = buildSystemPrompt();

    // Both are hidden: declared skill via registry, undeclared via persisted override.
    expect(result).not.toContain(`id="${DECLARED_SKILL_ID}"`);
    expect(result).not.toContain('id="twitter"');
  });
});
