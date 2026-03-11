import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let TEST_DIR = "";

mock.module("../util/platform.js", () => ({
  getRootDir: () => TEST_DIR,
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { ScaffoldManagedSkillTool } from "../tools/skills/scaffold-managed.js";
import type { ToolContext } from "../tools/types.js";

// Use internal class directly to avoid registry side effects

const tool = new (ScaffoldManagedSkillTool as any)() as InstanceType<
  typeof ScaffoldManagedSkillTool
>;

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test-session",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), "scaffold-tool-test-"));
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("scaffold_managed_skill tool", () => {
  test("creates a valid skill and index entry", async () => {
    const result = await tool.execute(
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
    expect(parsed.index_updated).toBe(true);

    const skillFile = join(TEST_DIR, "skills", "test-skill", "SKILL.md");
    expect(existsSync(skillFile)).toBe(true);
    const content = readFileSync(skillFile, "utf-8");
    expect(content).toContain('name: "Test Skill"');

    const indexContent = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    expect(indexContent).toContain("- test-skill");
  });

  test("rejects duplicate unless overwrite=true", async () => {
    await tool.execute(
      {
        skill_id: "dupe",
        name: "Original",
        description: "First",
        body_markdown: "V1.",
      },
      makeContext(),
    );

    const result2 = await tool.execute(
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

    const result3 = await tool.execute(
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
      const result = await tool.execute(input, makeContext());
      expect(result.isError).toBe(true);
    }
  });

  test("sanitizes embedded newlines in name/description/emoji to prevent frontmatter injection", async () => {
    const result = await tool.execute(
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
      expect(line).toMatch(
        /^(name|description|emoji|user-invocable|disable-model-invocation|metadata)(:\s|:$)/,
      );
    }
  });

  test("creates a skill with includes metadata", async () => {
    const result = await tool.execute(
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
    const result = await tool.execute(
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
    const result = await tool.execute(
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
    const result = await tool.execute(
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
    const result = await tool.execute(
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
    const result = await tool.execute(
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
    const result = await tool.execute(
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

  test("e2e: scaffold child then parent with includes, verify files and index", async () => {
    const childResult = await tool.execute(
      {
        skill_id: "e2e-child",
        name: "E2E Child",
        description: "Child for e2e test",
        body_markdown: "Child instructions.",
      },
      makeContext(),
    );
    expect(childResult.isError).toBe(false);

    const parentResult = await tool.execute(
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

    const indexContent = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    expect(indexContent).toContain("- e2e-child");
    expect(indexContent).toContain("- e2e-parent");
  });
});
