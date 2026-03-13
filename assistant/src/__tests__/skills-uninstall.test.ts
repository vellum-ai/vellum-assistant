import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { uninstallSkillLocally } from "../skills/catalog-install.js";

let tempDir: string;
let originalBaseDataDir: string | undefined;

function getSkillsDir(): string {
  return join(tempDir, ".vellum", "workspace", "skills");
}

function getSkillsIndexPath(): string {
  return join(getSkillsDir(), "SKILLS.md");
}

function installFakeSkill(skillId: string): void {
  const skillDir = join(getSkillsDir(), skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), `# ${skillId}\nA test skill.\n`);
}

function writeSkillsIndex(content: string): void {
  mkdirSync(getSkillsDir(), { recursive: true });
  writeFileSync(getSkillsIndexPath(), content);
}

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  mkdirSync(join(tempDir, ".vellum", "workspace", "skills"), {
    recursive: true,
  });
  originalBaseDataDir = process.env.BASE_DATA_DIR;
  process.env.BASE_DATA_DIR = tempDir;
});

afterEach(() => {
  process.env.BASE_DATA_DIR = originalBaseDataDir;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("assistant skills uninstall", () => {
  test("removes skill directory and SKILLS.md entry", () => {
    /**
     * Tests the happy path for uninstalling a skill.
     */

    // GIVEN a skill is installed locally
    installFakeSkill("weather");
    writeSkillsIndex("- weather\n- google-oauth-applescript\n");

    // WHEN we uninstall the skill
    uninstallSkillLocally("weather");

    // THEN the skill directory should be removed
    expect(existsSync(join(getSkillsDir(), "weather"))).toBe(false);

    // AND the SKILLS.md entry should be removed
    const index = readFileSync(getSkillsIndexPath(), "utf-8");
    expect(index).not.toContain("weather");

    // AND other skills should remain in the index
    expect(index).toContain("google-oauth-applescript");
  });

  test("errors when skill is not installed", () => {
    /**
     * Tests that uninstalling a non-existent skill throws an error.
     */

    // GIVEN no skills are installed
    // WHEN we try to uninstall a nonexistent skill
    // THEN it should throw an error
    expect(() => uninstallSkillLocally("nonexistent")).toThrow(
      'Skill "nonexistent" is not installed.',
    );
  });

  test("works when SKILLS.md does not exist", () => {
    /**
     * Tests that uninstall works even if the SKILLS.md index file is missing.
     */

    // GIVEN a skill directory exists but no SKILLS.md
    installFakeSkill("weather");

    // WHEN we uninstall the skill
    uninstallSkillLocally("weather");

    // THEN the skill directory should be removed
    expect(existsSync(join(getSkillsDir(), "weather"))).toBe(false);

    // AND no SKILLS.md should have been created
    expect(existsSync(getSkillsIndexPath())).toBe(false);
  });

  test("removes skill with nested files", () => {
    /**
     * Tests that uninstall recursively removes skills with nested directories.
     */

    // GIVEN a skill with nested files is installed
    const skillDir = join(getSkillsDir(), "weather");
    mkdirSync(join(skillDir, "scripts", "lib"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# weather\n");
    writeFileSync(join(skillDir, "scripts", "fetch.sh"), "#!/bin/bash\n");
    writeFileSync(join(skillDir, "scripts", "lib", "utils.sh"), "# utils\n");
    writeSkillsIndex("- weather\n");

    // WHEN we uninstall the skill
    uninstallSkillLocally("weather");

    // THEN the entire skill directory tree should be removed
    expect(existsSync(skillDir)).toBe(false);

    // AND the SKILLS.md entry should be removed
    const index = readFileSync(getSkillsIndexPath(), "utf-8");
    expect(index).not.toContain("weather");
  });
});
