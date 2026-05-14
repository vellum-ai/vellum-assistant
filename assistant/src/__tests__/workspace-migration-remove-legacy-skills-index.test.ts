import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import { removeLegacySkillsIndexMigration } from "../workspace/migrations/084-remove-legacy-skills-index.js";

let workspaceDir: string;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-migration-084-test-"));
});

afterEach(() => {
  if (existsSync(workspaceDir)) {
    rmSync(workspaceDir, { recursive: true, force: true });
  }
});

function writeSkill(skillId: string, body = "Body."): string {
  const skillDir = join(workspaceDir, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  const skillFilePath = join(skillDir, "SKILL.md");
  writeFileSync(
    skillFilePath,
    `---\nname: "${skillId}"\ndescription: "Test skill."\n---\n\n${body}\n`,
    "utf-8",
  );
  return skillFilePath;
}

function writeLegacyIndex(contents = "- alpha\n"): string {
  const skillsDir = join(workspaceDir, "skills");
  mkdirSync(skillsDir, { recursive: true });
  const legacyIndexPath = join(skillsDir, "SKILLS.md");
  writeFileSync(legacyIndexPath, contents, "utf-8");
  return legacyIndexPath;
}

function expectNestedSkillPreserved(
  legacyIndexPath: string,
  nestedSkillPath: string,
): void {
  const topLevelSkillPath = join(
    workspaceDir,
    "skills",
    "my-skill",
    "SKILL.md",
  );
  expect(existsSync(legacyIndexPath)).toBe(false);
  expect(existsSync(nestedSkillPath)).toBe(true);
  expect(readFileSync(topLevelSkillPath, "utf-8")).toContain("org/my-skill");
}

describe("084-remove-legacy-skills-index migration", () => {
  test("has correct id and description", () => {
    expect(removeLegacySkillsIndexMigration.id).toBe(
      "084-remove-legacy-skills-index",
    );
    expect(removeLegacySkillsIndexMigration.description).toContain("SKILLS.md");
    expect(removeLegacySkillsIndexMigration.retryFailedCheckpoint).toBe(true);
  });

  test("removes only skills/SKILLS.md when present", () => {
    const skillsDir = join(workspaceDir, "skills");
    const legacyIndexPath = writeLegacyIndex();

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

  test("removing a stale SKILLS.md index preserves omitted valid skill directories", () => {
    const legacyIndexPath = writeLegacyIndex("- indexed-skill\n");

    writeSkill("indexed-skill");
    writeSkill("omitted-skill");

    removeLegacySkillsIndexMigration.run(workspaceDir);

    expect(existsSync(legacyIndexPath)).toBe(false);
    expect(
      readFileSync(
        join(workspaceDir, "skills", "omitted-skill", "SKILL.md"),
        "utf-8",
      ),
    ).toContain("Body.");
  });

  test("copies nested indexed skills to top-level discovery location", () => {
    const legacyIndexPath = writeLegacyIndex("- org/my-skill\n");
    const nestedSkillPath = writeSkill("org/my-skill");

    removeLegacySkillsIndexMigration.run(workspaceDir);

    const topLevelSkillPath = join(
      workspaceDir,
      "skills",
      "my-skill",
      "SKILL.md",
    );
    expect(existsSync(legacyIndexPath)).toBe(false);
    expect(existsSync(nestedSkillPath)).toBe(true);
    expect(readFileSync(topLevelSkillPath, "utf-8")).toContain("org/my-skill");

    expect(readFileSync(topLevelSkillPath, "utf-8")).toContain("Body.");
  });

  test("copies nested indexed skills from plain entries that point to SKILL.md", () => {
    const legacyIndexPath = writeLegacyIndex("- org/my-skill/SKILL.md\n");
    const nestedSkillPath = writeSkill("org/my-skill");

    removeLegacySkillsIndexMigration.run(workspaceDir);

    expectNestedSkillPreserved(legacyIndexPath, nestedSkillPath);
  });

  test("copies nested indexed skills from markdown links that point to SKILL.md", () => {
    const legacyIndexPath = writeLegacyIndex(
      "- [My Skill](org/my-skill/skill.md)\n",
    );
    const nestedSkillPath = writeSkill("org/my-skill");

    removeLegacySkillsIndexMigration.run(workspaceDir);

    expectNestedSkillPreserved(legacyIndexPath, nestedSkillPath);
  });

  test("preserves nested indexed skill with alternate id when top-level basename exists", () => {
    const legacyIndexPath = writeLegacyIndex("- org/my-skill\n");
    const nestedSkillPath = writeSkill("org/my-skill", "Nested body.");
    const topLevelSkillPath = writeSkill("my-skill", "Top-level body.");

    removeLegacySkillsIndexMigration.run(workspaceDir);

    const preservedSkillPath = join(
      workspaceDir,
      "skills",
      "org__my-skill",
      "SKILL.md",
    );
    expect(existsSync(legacyIndexPath)).toBe(false);
    expect(readFileSync(nestedSkillPath, "utf-8")).toContain("Nested body.");
    expect(readFileSync(topLevelSkillPath, "utf-8")).toContain(
      "Top-level body.",
    );
    expect(readFileSync(preservedSkillPath, "utf-8")).toContain("Nested body.");

    expect(readFileSync(topLevelSkillPath, "utf-8")).toContain(
      "Top-level body.",
    );
    expect(readFileSync(preservedSkillPath, "utf-8")).toContain("Nested body.");
  });

  test("preserves same-basename nested indexed skills with unique top-level ids", () => {
    const legacyIndexPath = writeLegacyIndex(
      "- team-a/deploy\n- team-b/deploy\n",
    );
    const teamASkillPath = writeSkill("team-a/deploy", "Team A body.");
    const teamBSkillPath = writeSkill("team-b/deploy", "Team B body.");

    removeLegacySkillsIndexMigration.run(workspaceDir);

    const primaryPreservedSkillPath = join(
      workspaceDir,
      "skills",
      "deploy",
      "SKILL.md",
    );
    const alternatePreservedSkillPath = join(
      workspaceDir,
      "skills",
      "team-b__deploy",
      "SKILL.md",
    );

    expect(existsSync(legacyIndexPath)).toBe(false);
    expect(existsSync(teamASkillPath)).toBe(true);
    expect(existsSync(teamBSkillPath)).toBe(true);
    expect(readFileSync(primaryPreservedSkillPath, "utf-8")).toContain(
      "Team A body.",
    );
    expect(readFileSync(alternatePreservedSkillPath, "utf-8")).toContain(
      "Team B body.",
    );

    expect(readFileSync(primaryPreservedSkillPath, "utf-8")).toContain(
      "Team A body.",
    );
    expect(readFileSync(alternatePreservedSkillPath, "utf-8")).toContain(
      "Team B body.",
    );
  });

  test("does not follow legacy index entries outside the skills root", () => {
    const legacyIndexPath = writeLegacyIndex("- ../outside/my-skill\n");
    const outsideSkillDir = join(workspaceDir, "outside", "my-skill");
    mkdirSync(outsideSkillDir, { recursive: true });
    writeFileSync(
      join(outsideSkillDir, "SKILL.md"),
      "---\nname: Outside\ndescription: Outside skill.\n---\n\nOutside.\n",
      "utf-8",
    );

    removeLegacySkillsIndexMigration.run(workspaceDir);

    expect(existsSync(legacyIndexPath)).toBe(false);
    expect(existsSync(join(workspaceDir, "skills", "my-skill"))).toBe(false);
  });

  test("is safe to re-run", () => {
    const legacyIndexPath = writeLegacyIndex();

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

  test("rethrows unexpected lstat failures", () => {
    const legacyIndexPath = writeLegacyIndex();

    const lstatError = Object.assign(new Error("simulated lstat failure"), {
      code: "EACCES",
    });
    const lstatSpy = spyOn(fs, "lstatSync").mockImplementation(() => {
      throw lstatError;
    });

    try {
      expect(() => removeLegacySkillsIndexMigration.run(workspaceDir)).toThrow(
        lstatError,
      );
      expect(existsSync(legacyIndexPath)).toBe(true);
    } finally {
      lstatSpy.mockRestore();
    }
  });

  test("rethrows unexpected unlink failures and leaves SKILLS.md for retry", () => {
    const legacyIndexPath = writeLegacyIndex();

    const unlinkError = Object.assign(new Error("simulated unlink failure"), {
      code: "EACCES",
    });
    const unlinkSpy = spyOn(fs, "unlinkSync").mockImplementation(() => {
      throw unlinkError;
    });

    try {
      expect(() => removeLegacySkillsIndexMigration.run(workspaceDir)).toThrow(
        unlinkError,
      );
      expect(existsSync(legacyIndexPath)).toBe(true);
    } finally {
      unlinkSpy.mockRestore();
    }
  });

  test("down() is a no-op", () => {
    expect(() =>
      removeLegacySkillsIndexMigration.down(workspaceDir),
    ).not.toThrow();
  });
});
