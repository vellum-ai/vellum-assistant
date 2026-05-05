import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { loadSkillBySelector } from "../config/skills.js";
import { removeLegacySkillsIndexMigration } from "../workspace/migrations/068-remove-legacy-skills-index.js";

let workspaceDir: string;
let previousWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-068-test-"));
  previousWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
});

afterEach(() => {
  if (previousWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = previousWorkspaceDir;
  }
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function writeSkill(skillId: string): string {
  const skillDir = join(workspaceDir, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  const skillFilePath = join(skillDir, "SKILL.md");
  writeFileSync(
    skillFilePath,
    `---\nname: "${skillId}"\ndescription: "Test skill."\n---\n\nBody.\n`,
    "utf-8",
  );
  return skillFilePath;
}

describe("068-remove-legacy-skills-index migration", () => {
  test("has correct id and description", () => {
    expect(removeLegacySkillsIndexMigration.id).toBe(
      "068-remove-legacy-skills-index",
    );
    expect(removeLegacySkillsIndexMigration.description).toContain("SKILLS.md");
  });

  test("removes only skills/SKILLS.md when present", () => {
    const skillsDir = join(workspaceDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const legacyIndexPath = join(skillsDir, "SKILLS.md");
    writeFileSync(legacyIndexPath, "- alpha\n", "utf-8");

    const alphaSkillPath = writeSkill("alpha");
    const betaSkillPath = writeSkill("beta");
    const topLevelSkillPath = join(skillsDir, "SKILL.md");
    writeFileSync(
      topLevelSkillPath,
      "---\nname: Root\ndescription: Root file.\n---\n\nRoot.\n",
      "utf-8",
    );

    removeLegacySkillsIndexMigration.run(workspaceDir);

    expect(existsSync(legacyIndexPath)).toBe(false);
    expect(readFileSync(alphaSkillPath, "utf-8")).toContain("alpha");
    expect(readFileSync(betaSkillPath, "utf-8")).toContain("beta");
    expect(readFileSync(topLevelSkillPath, "utf-8")).toContain("Root");
  });

  test("is a no-op when skills/SKILLS.md is absent", () => {
    writeSkill("alpha");

    expect(() =>
      removeLegacySkillsIndexMigration.run(workspaceDir),
    ).not.toThrow();
    expect(existsSync(join(workspaceDir, "skills", "alpha", "SKILL.md"))).toBe(
      true,
    );
  });

  test("removing a stale SKILLS.md index preserves loadability for omitted valid skill directories", () => {
    const skillsDir = join(workspaceDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const legacyIndexPath = join(skillsDir, "SKILLS.md");
    writeFileSync(legacyIndexPath, "- indexed-skill\n", "utf-8");

    writeSkill("indexed-skill");
    writeSkill("omitted-skill");

    removeLegacySkillsIndexMigration.run(workspaceDir);

    expect(existsSync(legacyIndexPath)).toBe(false);
    const loaded = loadSkillBySelector("omitted-skill");
    expect(loaded.error).toBeUndefined();
    expect(loaded.skill).toBeDefined();
    expect(loaded.skill!.id).toBe("omitted-skill");
    expect(loaded.skill!.body).toBe("Body.");
  });

  test("is safe to re-run", () => {
    const skillsDir = join(workspaceDir, "skills");
    mkdirSync(skillsDir, { recursive: true });
    const legacyIndexPath = join(skillsDir, "SKILLS.md");
    writeFileSync(legacyIndexPath, "- alpha\n", "utf-8");

    removeLegacySkillsIndexMigration.run(workspaceDir);
    expect(() =>
      removeLegacySkillsIndexMigration.run(workspaceDir),
    ).not.toThrow();
    expect(existsSync(legacyIndexPath)).toBe(false);
  });

  test("does not recursively delete a directory named SKILLS.md", () => {
    const legacyIndexDir = join(workspaceDir, "skills", "SKILLS.md");
    mkdirSync(legacyIndexDir, { recursive: true });
    writeFileSync(join(legacyIndexDir, "nested.txt"), "keep\n", "utf-8");

    removeLegacySkillsIndexMigration.run(workspaceDir);

    expect(readFileSync(join(legacyIndexDir, "nested.txt"), "utf-8")).toBe(
      "keep\n",
    );
  });

  test("down() is a no-op", () => {
    expect(() =>
      removeLegacySkillsIndexMigration.down(workspaceDir),
    ).not.toThrow();
  });
});
