/**
 * Tests that skill_load rejects loading a skill whose feature flag is OFF
 * with a deterministic error message.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { setOverridesForTesting } from "./feature-flag-test-helpers.js";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

const DECLARED_SKILL_ID = "a2a-channel";
const DECLARED_FLAG_KEY = "a2a-channel";

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

const { skillLoadTool } = await import("../tools/skills/load.js");

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
  const tool = skillLoadTool;

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
    setOverridesForTesting({});
  });

  afterEach(() => {
    setOverridesForTesting({});
  });

  test("returns deterministic error for flag OFF skill", async () => {
    writeSkill(
      DECLARED_SKILL_ID,
      "A2A Channel",
      "Toggle A2A channel behavior",
      "Use the feature.",
    );

    setOverridesForTesting({ [DECLARED_FLAG_KEY]: false });

    const result = await executeSkillLoad({ skill: DECLARED_SKILL_ID });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("disabled by feature flag");
    expect(result.content).toContain(DECLARED_SKILL_ID);
  });

  test("loads skill normally when flag is ON", async () => {
    writeSkill(
      DECLARED_SKILL_ID,
      "A2A Channel",
      "Toggle A2A channel behavior",
      "Use the feature.",
    );

    setOverridesForTesting({ [DECLARED_FLAG_KEY]: true });

    const result = await executeSkillLoad({ skill: DECLARED_SKILL_ID });

    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: A2A Channel");
  });

  test("returns error when flag key is absent (registry defaults to disabled)", async () => {
    writeSkill(
      DECLARED_SKILL_ID,
      "A2A Channel",
      "Toggle A2A channel behavior",
      "Use the feature.",
    );

    // No overrides — uses registry defaults

    const result = await executeSkillLoad({ skill: DECLARED_SKILL_ID });

    // a2a-channel is declared in the registry with defaultEnabled: false
    expect(result.isError).toBe(true);
    expect(result.content).toContain("disabled by feature flag");
  });
});
