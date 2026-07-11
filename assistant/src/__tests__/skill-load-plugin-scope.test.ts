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

import type { SkillDefinition, SkillSummary } from "../config/skills.js";

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

// ── Include-path scope fixtures ────────────────────────────────────────────
// An in-scope parent (plugin "p") that includes three children: a bundled/core
// child (always allowed), an in-scope plugin child (plugin "p"), and an
// out-of-scope plugin child (plugin "q", not in the effective set).
const childCoreSkill: SkillDefinition = {
  id: "child-core",
  name: "child-core",
  displayName: "Child Core",
  description: "Bundled child, always allowed",
  directoryPath: skillDir,
  skillFilePath: join(skillDir, "SKILL.md"),
  source: "bundled",
  body: "CHILD CORE BODY",
  includes: [],
};
const childInSkill: SkillDefinition = {
  id: "child-in",
  name: "child-in",
  displayName: "Child In",
  description: "In-scope child owned by plugin p",
  directoryPath: skillDir,
  skillFilePath: join(skillDir, "SKILL.md"),
  source: "plugin",
  owner: { kind: "plugin", id: "p" },
  body: "CHILD IN BODY",
  includes: [],
};
const childOutSkill: SkillDefinition = {
  id: "child-out",
  name: "child-out",
  displayName: "Child Out",
  description: "Out-of-scope child owned by plugin q",
  directoryPath: skillDir,
  skillFilePath: join(skillDir, "SKILL.md"),
  source: "plugin",
  owner: { kind: "plugin", id: "q" },
  body: "CHILD OUT BODY",
  includes: [],
};
const parentSkill: SkillDefinition = {
  id: "parent-skill",
  name: "parent-skill",
  displayName: "Parent Skill",
  description: "In-scope parent including a child per plugin",
  directoryPath: skillDir,
  skillFilePath: join(skillDir, "SKILL.md"),
  source: "plugin",
  owner: { kind: "plugin", id: "p" },
  body: "PARENT BODY",
  includes: ["child-core", "child-in", "child-out"],
};

const skillsById: Record<string, SkillDefinition> = {
  "plug-skill": pluginSkill,
  "parent-skill": parentSkill,
  "child-core": childCoreSkill,
  "child-in": childInSkill,
  "child-out": childOutSkill,
};

// Catalog summaries drive the include-path gate: `catalogIndex.get(childId)`
// supplies each child's `owner`, so the gate must read owners from here.
const catalogSummaries: SkillSummary[] = [
  parentSkill,
  childCoreSkill,
  childInSkill,
  childOutSkill,
].map(({ body: _body, ...summary }) => summary);

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realSkills = require("../config/skills.js");
mock.module("../config/skills.js", () => ({
  ...realSkills,
  loadSkillBySelector: (selector: string) => {
    const skill = skillsById[selector];
    return skill
      ? { skill }
      : {
          skill: undefined,
          error: `not found: ${selector}`,
          errorCode: "not_found",
        };
  },
  loadSkillCatalog: () => catalogSummaries,
}));

const { skillLoadTool } = await import("../tools/skills/load.js");

const REJECTION = "not available in this conversation";

async function loadWithScope(
  enabledPluginSet: Set<string> | null | undefined,
  selector = "plug-skill",
): Promise<{ content: string; isError: boolean }> {
  const tool = skillLoadTool;
  const result = await tool.execute(
    { skill: selector },
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

describe("skill_load — per-chat plugin scope on included children", () => {
  test("omits an out-of-scope plugin child's body + marker, keeps in-scope/core children", async () => {
    // Chat scoped to plugin "p". Parent (plugin "p") includes a core child, an
    // in-scope plugin child, and an out-of-scope plugin "q" child.
    const result = await loadWithScope(new Set(["p"]), "parent-skill");

    expect(result.isError).toBe(false);
    expect(result.content).toContain("PARENT BODY");

    // Core (bundled) and in-scope plugin children: body + loaded-skill marker.
    expect(result.content).toContain("CHILD CORE BODY");
    expect(result.content).toContain('<loaded_skill id="child-core"');
    expect(result.content).toContain("CHILD IN BODY");
    expect(result.content).toContain('<loaded_skill id="child-in"');

    // Out-of-scope plugin "q" child: no body, no marker, not even listed.
    expect(result.content).not.toContain("CHILD OUT BODY");
    expect(result.content).not.toContain("child-out");
  });

  test("with no restriction (null set) the out-of-scope child is included", async () => {
    const result = await loadWithScope(null, "parent-skill");

    expect(result.isError).toBe(false);
    // Without a per-chat restriction every included child is injected.
    expect(result.content).toContain("CHILD OUT BODY");
    expect(result.content).toContain('<loaded_skill id="child-out"');
  });
});
