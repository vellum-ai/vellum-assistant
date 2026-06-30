/**
 * Tests that `skill_load` rejects loading a plugin-owned skill whose owning
 * plugin is outside the conversation's effective per-chat plugin set, and lets
 * it through when the plugin is in scope (or when there is no restriction).
 *
 * `loadSkillBySelector` is mocked to return a plugin-owned skill rooted at a
 * real temp dir so the in-scope path can complete the full load.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, mock, test } from "bun:test";

import type { SkillDefinition } from "../config/skills.js";

const noopLogger = new Proxy({} as Record<string, unknown>, {
  get: (_t, prop) => (prop === "child" ? () => noopLogger : () => {}),
});

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  truncateForLog: (s: unknown) => String(s),
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({}),
  getConfigReadOnly: () => ({}),
  loadConfig: () => ({}),
  loadRawConfig: () => ({}),
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
    "tavily",
  ],
}));

// A real directory so the in-scope load's filesystem reads (reference listing,
// version hash, tool manifest) succeed.
const skillDir = mkdtempSync(join(tmpdir(), "skill-plugin-scope-"));
writeFileSync(
  join(skillDir, "SKILL.md"),
  `---\nname: "plug-skill"\ndescription: "Owned by plugin p"\n---\n\nDo the plugin thing.\n`,
);

const pluginSkill: SkillDefinition = {
  id: "plug-skill",
  name: "plug-skill",
  displayName: "Plugin Skill",
  description: "Owned by plugin p",
  directoryPath: skillDir,
  skillFilePath: join(skillDir, "SKILL.md"),
  source: "plugin",
  owner: { kind: "plugin", id: "p" },
  body: "Do the plugin thing.",
  includes: [],
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realSkills = require("../config/skills.js");
mock.module("../config/skills.js", () => ({
  ...realSkills,
  loadSkillBySelector: () => ({ skill: pluginSkill }),
}));

await import("../tools/skills/load.js");
const { getTool } = await import("../tools/registry.js");

const REJECTION = "not available in this conversation";

async function loadWithScope(
  enabledPluginSet: Set<string> | null | undefined,
): Promise<{ content: string; isError: boolean }> {
  const tool = getTool("skill_load");
  if (!tool) throw new Error("skill_load tool was not registered");
  const result = await tool.execute(
    { skill: "plug-skill" },
    {
      workingDir: "/tmp",
      conversationId: "conversation-1",
      trustClass: "guardian",
      enabledPluginSet,
    },
  );
  return { content: result.content, isError: result.isError };
}

describe("skill_load — per-chat plugin scope", () => {
  test("rejects a plugin skill whose owner is outside the effective set", async () => {
    const result = await loadWithScope(new Set(["other"]));
    expect(result.isError).toBe(true);
    expect(result.content).toContain(REJECTION);
    expect(result.content).toContain("plug-skill");
  });

  test("loads the plugin skill when its owner is in the effective set", async () => {
    const result = await loadWithScope(new Set(["p"]));
    expect(result.content).not.toContain(REJECTION);
    expect(result.isError).toBe(false);
    expect(result.content).toContain("Skill: Plugin Skill");
  });

  test("null set (no per-chat restriction) loads the plugin skill", async () => {
    const result = await loadWithScope(null);
    expect(result.content).not.toContain(REJECTION);
    expect(result.isError).toBe(false);
  });

  test("absent set (no per-chat restriction) loads the plugin skill", async () => {
    const result = await loadWithScope(undefined);
    expect(result.content).not.toContain(REJECTION);
    expect(result.isError).toBe(false);
  });
});
