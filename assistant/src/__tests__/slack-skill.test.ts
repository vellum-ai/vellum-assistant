import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO_SKILLS_DIR = join(import.meta.dir, "..", "..", "..", "skills");

describe("slack skill has no TOOLS.json (uses Web API via CLI)", () => {
  const toolsPath = join(REPO_SKILLS_DIR, "slack", "TOOLS.json");

  test("TOOLS.json does not exist", () => {
    expect(() => readFileSync(toolsPath)).toThrow();
  });
});

describe("slack skill SKILL.md", () => {
  const skillMd = readFileSync(
    join(REPO_SKILLS_DIR, "slack", "SKILL.md"),
    "utf-8",
  );

  test("has correct frontmatter name", () => {
    expect(skillMd).toContain("name: slack");
  });

  test("mentions privacy rules", () => {
    expect(skillMd).toContain("is_private");
    expect(skillMd).toContain("must NEVER be shared");
  });
});
