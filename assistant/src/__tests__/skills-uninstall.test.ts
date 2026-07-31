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

import { uninstallSkillLocally } from "../skills/uninstall.js";

let tempDir: string;
let originalWorkspaceDir: string | undefined;

function getSkillsDir(): string {
  return join(tempDir, "skills");
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
  mkdirSync(join(tempDir, "skills"), { recursive: true });
  originalWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = tempDir;
});

afterEach(() => {
  if (originalWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = originalWorkspaceDir;
  }
  rmSync(tempDir, { recursive: true, force: true });
});

describe("assistant skills uninstall", () => {
  test("removes skill directory while leaving a stale SKILLS.md index unchanged", () => {
    installFakeSkill("weather");
    const originalIndex = "- weather\n- vellum-self-knowledge\n";
    writeSkillsIndex(originalIndex);

    uninstallSkillLocally("weather");

    expect(existsSync(join(getSkillsDir(), "weather"))).toBe(false);

    const index = readFileSync(getSkillsIndexPath(), "utf-8");
    expect(index).toBe(originalIndex);
  });

  test("errors when skill is not installed", () => {
    expect(() => uninstallSkillLocally("nonexistent")).toThrow(
      'Skill "nonexistent" is not installed.',
    );
  });

  test("works when no stale SKILLS.md index exists", () => {
    installFakeSkill("weather");

    uninstallSkillLocally("weather");

    expect(existsSync(join(getSkillsDir(), "weather"))).toBe(false);

    expect(existsSync(getSkillsIndexPath())).toBe(false);
  });

  test("removes skill with nested files while leaving a stale SKILLS.md index unchanged", () => {
    const skillDir = join(getSkillsDir(), "weather");
    mkdirSync(join(skillDir, "scripts", "lib"), { recursive: true });
    writeFileSync(join(skillDir, "SKILL.md"), "# weather\n");
    writeFileSync(join(skillDir, "scripts", "fetch.sh"), "#!/bin/bash\n");
    writeFileSync(join(skillDir, "scripts", "lib", "utils.sh"), "# utils\n");
    const originalIndex = "- weather\n";
    writeSkillsIndex(originalIndex);

    uninstallSkillLocally("weather");

    expect(existsSync(skillDir)).toBe(false);

    const index = readFileSync(getSkillsIndexPath(), "utf-8");
    expect(index).toBe(originalIndex);
  });
});
