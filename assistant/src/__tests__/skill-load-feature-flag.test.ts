/**
 * Tests that skill_load rejects loading a skill whose feature flag is OFF
 * with a deterministic error message.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

let currentConfig: Record<string, unknown> = {};

const DECLARED_SKILL_ID = "sounds";
const DECLARED_FLAG_KEY = "sounds";

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
  deepMergeOverwrite: (a: unknown) => a,
  mergeDefaultWorkspaceConfig: () => {},
  API_KEY_PROVIDERS: [
    "anthropic",
    "openai",
    "gemini",
    "ollama",
    "fireworks",
    "openrouter",
    "brave",
    "perplexity",
  ],
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
    _setOverridesForTesting({});
  });

  afterEach(() => {
    _setOverridesForTesting({});
  });

  test("returns deterministic error for flag OFF skill", async () => {
    writeSkill(
      DECLARED_SKILL_ID,
      "Sounds",
      "Toggle sounds behavior",
      "Use the feature.",
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      `- ${DECLARED_SKILL_ID}\n`,
    );

    _setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });

    const result = await executeSkillLoad({ skill: DECLARED_SKILL_ID });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("disabled by feature flag");
    expect(result.content).toContain(DECLARED_SKILL_ID);
  });

  test("loads skill normally when flag is ON", async () => {
    writeSkill(
      DECLARED_SKILL_ID,
      "Sounds",
      "Toggle sounds behavior",
      "Use the feature.",
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      `- ${DECLARED_SKILL_ID}\n`,
    );

    _setOverridesForTesting({ [DECLARED_FLAG_KEY]: true });

    const result = await executeSkillLoad({ skill: DECLARED_SKILL_ID });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Sounds");
  });

  test("loads skill when flag key is absent (registry defaults to enabled)", async () => {
    writeSkill(
      DECLARED_SKILL_ID,
      "Sounds",
      "Toggle sounds behavior",
      "Use the feature.",
    );
    writeFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      `- ${DECLARED_SKILL_ID}\n`,
    );

    // No overrides — uses registry defaults

    const result = await executeSkillLoad({ skill: DECLARED_SKILL_ID });

    // sounds is declared in the registry with defaultEnabled: true
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Sounds");
  });
});
