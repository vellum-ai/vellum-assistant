/**
 * Tests that skill_load rejects loading a skill whose feature flag is OFF
 * with a deterministic error message.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = join(
  tmpdir(),
  `vellum-skill-load-flag-test-${crypto.randomUUID()}`,
);

let currentConfig: Record<string, unknown> = {};

const DECLARED_SKILL_ID = "contacts";
const DECLARED_FLAG_KEY = "feature_flags.contacts.enabled";

const platformOverrides: Record<string, (...args: unknown[]) => unknown> = {
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  ensureDataDir: () => {},
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getWorkspaceDir: () => join(TEST_DIR, "workspace"),
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
  getWorkspaceConfigPath: () => join(TEST_DIR, "workspace", "config.json"),
  getWorkspaceHooksDir: () => join(TEST_DIR, "workspace", "hooks"),
  getWorkspacePromptPath: (f: unknown) =>
    join(TEST_DIR, "workspace", String(f)),
  getInterfacesDir: () => join(TEST_DIR, "interfaces"),
  getHooksDir: () => join(TEST_DIR, "hooks"),

  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => join(TEST_DIR, "sandbox", "work"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  getSessionTokenPath: () => join(TEST_DIR, "session-token"),
  readSessionToken: () => null,
  getClipboardCommand: () => null,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
};
// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  ...platformOverrides,
}));

const noopLogger = new Proxy({} as Record<string, unknown>, {
  get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (value: string) => value,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => currentConfig,
  loadConfig: () => currentConfig,
  loadRawConfig: () => ({}),
  saveConfig: () => {},
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

await import("../tools/skills/load.js");
const { getTool } = await import("../tools/registry.js");

function writeSkill(
  skillId: string,
  name: string,
  description: string,
  body: string,
): void {
  const skillDir = join(TEST_DIR, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\nmetadata: {"vellum":{"feature-flag":"${skillId}"}}\n---\n\n${body}\n`,
  );
}

async function executeSkillLoad(
  input: Record<string, unknown>,
): Promise<{ content: string; isError: boolean }> {
  const tool = getTool("skill_load");
  if (!tool) throw new Error("skill_load tool was not registered");

  const result = await tool.execute(input, {
    workingDir: "/tmp",
    conversationId: "conversation-1",
    trustClass: "guardian",
  });
  return { content: result.content, isError: result.isError };
}

describe("skill_load feature flag enforcement", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
    currentConfig = {};
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("returns deterministic error for flag OFF skill", async () => {
    writeSkill(
      DECLARED_SKILL_ID,
      "Contacts",
      "Toggle contacts behavior",
      "Use the feature.",
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      `- ${DECLARED_SKILL_ID}\n`,
    );

    currentConfig = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: false },
    };

    const result = await executeSkillLoad({ skill: DECLARED_SKILL_ID });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("disabled by feature flag");
    expect(result.content).toContain(DECLARED_SKILL_ID);
  });

  test("loads skill normally when flag is ON", async () => {
    writeSkill(
      DECLARED_SKILL_ID,
      "Contacts",
      "Toggle contacts behavior",
      "Use the feature.",
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      `- ${DECLARED_SKILL_ID}\n`,
    );

    currentConfig = {
      assistantFeatureFlagValues: { [DECLARED_FLAG_KEY]: true },
    };

    const result = await executeSkillLoad({ skill: DECLARED_SKILL_ID });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Contacts");
  });

  test("loads skill when flag key is absent (registry defaults to enabled)", async () => {
    writeSkill(
      DECLARED_SKILL_ID,
      "Contacts",
      "Toggle contacts behavior",
      "Use the feature.",
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      `- ${DECLARED_SKILL_ID}\n`,
    );

    currentConfig = {
      assistantFeatureFlagValues: {},
    };

    const result = await executeSkillLoad({ skill: DECLARED_SKILL_ID });

    // contacts is declared in the registry with defaultEnabled: true
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Contacts");
  });
});
