import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;
const mockRefreshSkillCapabilityMemories = mock(() => {});

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../daemon/skill-memory-refresh.js", () => ({
  refreshSkillCapabilityMemories: mockRefreshSkillCapabilityMemories,
}));

import { loadSkillCatalog } from "../config/skills.js";
import { readInstallMeta } from "../skills/install-meta.js";
import { executeScaffoldManagedSkill } from "../tools/skills/scaffold-managed.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp",
    conversationId: "test-conversation",
    trustClass: "guardian",
    ...overrides,
  };
}

/** A retrospective-pass tool context (assistant-authored scaffolds). */
function makeRetrospectiveContext(): ToolContext {
  return makeContext({ requestOrigin: "memory_retrospective" });
}

function installMetaFor(skillId: string) {
  return readInstallMeta(join(TEST_DIR, "skills", skillId));
}

beforeEach(() => {
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
  mockRefreshSkillCapabilityMemories.mockClear();
});

afterEach(() => {
  rmSync(join(TEST_DIR, "skills"), { recursive: true, force: true });
});

describe("scaffold_managed_skill tool", () => {
  test("keeps legacy index control as a deprecated no-op schema field", () => {
    const tools = JSON.parse(
      readFileSync(
        join(
          import.meta.dirname,
          "../config/bundled-skills/skill-management/TOOLS.json",
        ),
        "utf-8",
      ),
    );
    const scaffoldTool = tools.tools.find(
      (tool: { name: string }) => tool.name === "scaffold_managed_skill",
    );

    expect(scaffoldTool).toBeDefined();
    expect(scaffoldTool.input_schema.properties.add_to_index).toEqual({
      type: "boolean",
      description:
        "Deprecated no-op compatibility field. Skills are discovered from top-level SKILL.md files.",
    });
  });

  test("creates a valid skill discovered from its SKILL.md directory", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "test-skill",
        name: "Test Skill",
        description: "A test skill",
        body_markdown: "Do the thing.",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.created).toBe(true);
    expect(parsed.skill_id).toBe("test-skill");
    expect(parsed).not.toHaveProperty("index_updated");

    const skillFile = join(TEST_DIR, "skills", "test-skill", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    const content = readFileSync(skillFile, "utf-8");
    expect(content).toContain('name: "Test Skill"');

    expect(existsSync(join(TEST_DIR, "skills", "SKILLS.md"))).toBe(false);

    const catalog = loadSkillCatalog();
    const skill = catalog.find((s) => s.id === "test-skill");
    expect(skill).toBeDefined();
    expect(skill!.name).toBe("Test Skill");
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
  });

  test("accepts legacy add_to_index input without returning index metadata", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "legacy-input",
        name: "Legacy Input",
        description: "A test skill",
        body_markdown: "Do the thing.",
        add_to_index: true,
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.created).toBe(true);
    expect(parsed).not.toHaveProperty("index_updated");
    expect(existsSync(join(TEST_DIR, "skills", "SKILLS.md"))).toBe(false);
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
  });

  test("rejects duplicate unless overwrite=true", async () => {
    await executeScaffoldManagedSkill(
      {
        skill_id: "dupe",
        name: "Original",
        description: "First",
        body_markdown: "V1.",
      },
      makeContext(),
    );

    const result2 = await executeScaffoldManagedSkill(
      {
        skill_id: "dupe",
        name: "Duplicate",
        description: "Second",
        body_markdown: "V2.",
      },
      makeContext(),
    );
    expect(result2.isError).toBe(true);
    expect(result2.content).toContain("already exists");

    const result3 = await executeScaffoldManagedSkill(
      {
        skill_id: "dupe",
        name: "Overwritten",
        description: "Third",
        body_markdown: "V3.",
        overwrite: true,
      },
      makeContext(),
    );
    expect(result3.isError).toBe(false);
  });

  test("rejects missing required fields", async () => {
    const cases = [
      { name: "N", description: "D", body_markdown: "B" }, // missing skill_id
      { skill_id: "s", description: "D", body_markdown: "B" }, // missing name
      { skill_id: "s", name: "N", body_markdown: "B" }, // missing description
      { skill_id: "s", name: "N", description: "D" }, // missing body_markdown
    ];

    for (const input of cases) {
      const result = await executeScaffoldManagedSkill(input, makeContext());
      expect(result.isError).toBe(true);
    }
  });

  test("sanitizes embedded newlines in name/description/emoji to prevent frontmatter injection", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "inject-test",
        name: 'Test\ninjected_field: "evil"',
        description: "Desc\rwith\r\ncarriage returns",
        body_markdown: "Body content.",
        emoji: "🔥\nextra: true",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const skillFile = join(TEST_DIR, "skills", "inject-test", "SKILL.md");
    const content = readFileSync(skillFile, "utf-8");

    // Newlines must not appear inside frontmatter values
    const frontmatter = content.split("---")[1];
    // Only check top-level (non-indented) keys — nested YAML under metadata: is expected
    const fmLines = frontmatter
      .split("\n")
      .filter((l) => l.trim() && !l.match(/^\s/));
    // Each top-level frontmatter line must start with a known key -- no injected keys
    for (const line of fmLines) {
      expect(line).toMatch(/^(name|description|emoji|metadata)(:\s|:$)/);
    }
  });

  test("creates a skill with includes metadata", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "parent-skill",
        name: "Parent",
        description: "Has children",
        body_markdown: "Parent body.",
        includes: ["child-a", "child-b"],
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const skillFile = join(TEST_DIR, "skills", "parent-skill", "SKILL.md");
    const content = readFileSync(skillFile, "utf-8");
    expect(content).toContain("    includes:");
    expect(content).toContain("      - child-a");
    expect(content).toContain("      - child-b");
  });

  test("normalizes includes — trims and deduplicates", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "norm-skill",
        name: "Normalized",
        description: "Tests normalization",
        body_markdown: "Body.",
        includes: ["  child-a  ", "child-b", "child-a"],
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const skillFile = join(TEST_DIR, "skills", "norm-skill", "SKILL.md");
    const content = readFileSync(skillFile, "utf-8");
    expect(content).toContain("    includes:");
    expect(content).toContain("      - child-a");
    expect(content).toContain("      - child-b");
  });

  test("rejects includes with non-string elements", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "bad-includes",
        name: "Bad",
        description: "Has non-string",
        body_markdown: "Body.",
        includes: ["child-a", 42],
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty string");
  });

  test("rejects includes with empty string elements", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "empty-includes",
        name: "Empty",
        description: "Has empty string",
        body_markdown: "Body.",
        includes: ["", "child-a"],
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty string");
  });

  test("rejects includes with whitespace-only elements", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "ws-includes",
        name: "Whitespace",
        description: "Has whitespace-only",
        body_markdown: "Body.",
        includes: ["child-a", "  "],
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("non-empty string");
  });

  test("omits includes when not provided", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "no-includes",
        name: "Solo",
        description: "No children",
        body_markdown: "Body.",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const skillFile = join(TEST_DIR, "skills", "no-includes", "SKILL.md");
    const content = readFileSync(skillFile, "utf-8");
    expect(content).not.toContain("includes");
  });

  test("rejects invalid skill_id", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "../escape",
        name: "Bad",
        description: "Bad",
        body_markdown: "Bad.",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("traversal");
  });

  test("writes companion files under the skill dir", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "files-skill",
        name: "Files Skill",
        description: "Has companion files",
        body_markdown: "See references/failure-modes.md.",
        files: [
          {
            path: "references/failure-modes.md",
            content: "# Failure modes\n",
          },
        ],
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    const companionPath = join(
      TEST_DIR,
      "skills",
      "files-skill",
      "references",
      "failure-modes.md",
    );
    expect(existsSync(companionPath)).toBe(true);
    expect(readFileSync(companionPath, "utf-8")).toBe("# Failure modes\n");
    expect(mockRefreshSkillCapabilityMemories).toHaveBeenCalledTimes(1);
  });

  test("rejects companion file path traversal with no partial writes", async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "files-traversal",
        name: "Traversal",
        description: "Bad path",
        body_markdown: "Body.",
        files: [{ path: "../escape.md", content: "owned" }],
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("..");
    expect(
      existsSync(join(TEST_DIR, "skills", "files-traversal", "SKILL.md")),
    ).toBe(false);
    expect(existsSync(join(TEST_DIR, "skills", "escape.md"))).toBe(false);
    expect(mockRefreshSkillCapabilityMemories).not.toHaveBeenCalled();
  });

  test("rejects malformed files input", async () => {
    const cases: unknown[] = [
      "not-an-array",
      [{ content: "missing path" }],
      [{ path: "ok.md" }],
      [{ path: 42, content: "bad path type" }],
      [{ path: "ok.md", content: 7 }],
      ["just-a-string"],
    ];

    for (const files of cases) {
      const result = await executeScaffoldManagedSkill(
        {
          skill_id: "bad-files",
          name: "Bad",
          description: "Bad files",
          body_markdown: "Body.",
          files,
        },
        makeContext(),
      );
      expect(result.isError).toBe(true);
    }
  });

  test("e2e: scaffold child then parent with includes, verify file discovery", async () => {
    const childResult = await executeScaffoldManagedSkill(
      {
        skill_id: "e2e-child",
        name: "E2E Child",
        description: "Child for e2e test",
        body_markdown: "Child instructions.",
      },
      makeContext(),
    );
    expect(childResult.isError).toBe(false);

    const parentResult = await executeScaffoldManagedSkill(
      {
        skill_id: "e2e-parent",
        name: "E2E Parent",
        description: "Parent with includes",
        body_markdown: "Parent instructions.",
        includes: ["e2e-child"],
      },
      makeContext(),
    );
    expect(parentResult.isError).toBe(false);

    const parentSkillFile = join(TEST_DIR, "skills", "e2e-parent", "SKILL.md");
    expect(existsSync(parentSkillFile)).toBe(true);
    const parentContent = readFileSync(parentSkillFile, "utf-8");
    expect(parentContent).toContain("    includes:");
    expect(parentContent).toContain("      - e2e-child");

    expect(existsSync(join(TEST_DIR, "skills", "SKILLS.md"))).toBe(false);

    const catalog = loadSkillCatalog();
    expect(catalog.find((s) => s.id === "e2e-child")).toBeDefined();
    const parent = catalog.find((s) => s.id === "e2e-parent");
    expect(parent).toBeDefined();
    expect(parent!.includes).toEqual(["e2e-child"]);
  });

  // ── Authorship tagging + user-skill protection ────────────────────────────

  test('tags author "assistant" under the retrospective origin', async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "retro-skill",
        name: "Retro Skill",
        description: "Authored by a retrospective pass",
        body_markdown: "Do the procedure.",
      },
      makeRetrospectiveContext(),
    );

    expect(result.isError).toBe(false);
    expect(installMetaFor("retro-skill")?.author).toBe("assistant");
  });

  test('tags author "user" for a normal (non-retrospective) scaffold', async () => {
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "user-skill",
        name: "User Skill",
        description: "Authored interactively",
        body_markdown: "Do the thing.",
      },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(installMetaFor("user-skill")?.author).toBe("user");
  });

  test("retrospective refuses to overwrite an author:user skill", async () => {
    // A user authors the skill first.
    await executeScaffoldManagedSkill(
      {
        skill_id: "protected",
        name: "Protected",
        description: "User authored",
        body_markdown: "Original body.",
      },
      makeContext(),
    );
    expect(installMetaFor("protected")?.author).toBe("user");

    // The retrospective tries to overwrite it — refused.
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "protected",
        name: "Protected",
        description: "Rewritten by retrospective",
        body_markdown: "Rewritten body.",
        overwrite: true,
      },
      makeRetrospectiveContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("user-authored");
    // The original body and authorship are untouched.
    const skillFile = join(TEST_DIR, "skills", "protected", "SKILL.md");
    expect(readFileSync(skillFile, "utf-8")).toContain("Original body.");
    expect(installMetaFor("protected")?.author).toBe("user");
  });

  test("retrospective refuses to write companion files into an author:user skill", async () => {
    await executeScaffoldManagedSkill(
      {
        skill_id: "protected-files",
        name: "Protected Files",
        description: "User authored",
        body_markdown: "Original body.",
      },
      makeContext(),
    );

    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "protected-files",
        name: "Protected Files",
        description: "Refine attempt",
        body_markdown: "Original body.",
        overwrite: true,
        files: [{ path: "references/notes.md", content: "gotchas" }],
      },
      makeRetrospectiveContext(),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("user-authored");
    expect(
      existsSync(
        join(TEST_DIR, "skills", "protected-files", "references", "notes.md"),
      ),
    ).toBe(false);
  });

  test("retrospective MAY overwrite its own author:assistant skill", async () => {
    // The retrospective authors a skill, then refines it later.
    await executeScaffoldManagedSkill(
      {
        skill_id: "assistant-owned",
        name: "Assistant Owned",
        description: "First pass",
        body_markdown: "V1 procedure.",
      },
      makeRetrospectiveContext(),
    );
    expect(installMetaFor("assistant-owned")?.author).toBe("assistant");

    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "assistant-owned",
        name: "Assistant Owned",
        description: "Refined",
        body_markdown: "V2 procedure.",
        overwrite: true,
        files: [{ path: "references/failure-modes.md", content: "gotchas" }],
      },
      makeRetrospectiveContext(),
    );

    expect(result.isError).toBe(false);
    const skillFile = join(TEST_DIR, "skills", "assistant-owned", "SKILL.md");
    expect(readFileSync(skillFile, "utf-8")).toContain("V2 procedure.");
    expect(installMetaFor("assistant-owned")?.author).toBe("assistant");
    expect(
      existsSync(
        join(
          TEST_DIR,
          "skills",
          "assistant-owned",
          "references",
          "failure-modes.md",
        ),
      ),
    ).toBe(true);
  });
});
