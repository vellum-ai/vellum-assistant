import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { skills } from "../commands/skills.js";

let tempDir: string;
let originalArgv: string[];
let originalBaseDataDir: string | undefined;
let originalExitCode: number | string | null | undefined;

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
  tempDir = join(tmpdir(), `skills-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(tempDir, ".vellum", "workspace", "skills"), {
    recursive: true,
  });
  originalArgv = process.argv;
  originalBaseDataDir = process.env.BASE_DATA_DIR;
  originalExitCode = process.exitCode;
  process.env.BASE_DATA_DIR = tempDir;
});

afterEach(() => {
  process.argv = originalArgv;
  process.env.BASE_DATA_DIR = originalBaseDataDir;
  // Bun treats `process.exitCode = undefined` as a no-op, so explicitly
  // reset to 0 when the original value was not set.
  process.exitCode = originalExitCode ?? 0;
  rmSync(tempDir, { recursive: true, force: true });
});

describe("vellum skills uninstall", () => {
  test("removes skill directory and SKILLS.md entry", async () => {
    /**
     * Tests the happy path for uninstalling a skill.
     */

    // GIVEN a skill is installed locally
    installFakeSkill("weather");
    writeSkillsIndex("- weather\n- google-oauth-setup\n");

    // WHEN we run `vellum skills uninstall weather`
    process.argv = ["bun", "run", "skills", "uninstall", "weather"];
    await skills();

    // THEN the skill directory should be removed
    expect(existsSync(join(getSkillsDir(), "weather"))).toBe(false);

    // AND the SKILLS.md entry should be removed
    const index = readFileSync(getSkillsIndexPath(), "utf-8");
    expect(index).not.toContain("weather");

    // AND other skills should remain in the index
    expect(index).toContain("google-oauth-setup");
  });

  test("outputs JSON on success when --json flag is passed", async () => {
    /**
     * Tests that --json flag produces machine-readable output.
     */

    // GIVEN a skill is installed locally
    installFakeSkill("weather");
    writeSkillsIndex("- weather\n");

    // WHEN we run `vellum skills uninstall weather --json`
    process.argv = ["bun", "run", "skills", "uninstall", "weather", "--json"];
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await skills();
    } finally {
      console.log = origLog;
    }

    // THEN JSON output should indicate success
    const output = JSON.parse(logs[0]);
    expect(output).toEqual({ ok: true, skillId: "weather" });
  });

  test("errors when skill is not installed", async () => {
    /**
     * Tests that uninstalling a non-existent skill produces an error.
     */

    // GIVEN no skills are installed
    // WHEN we run `vellum skills uninstall nonexistent`
    process.argv = ["bun", "run", "skills", "uninstall", "nonexistent"];
    const errors: string[] = [];
    const origError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(" "));
    try {
      await skills();
    } finally {
      console.error = origError;
    }

    // THEN an error message should be displayed
    expect(errors[0]).toContain('Skill "nonexistent" is not installed.');
    expect(process.exitCode).toBe(1);
  });

  test("errors with JSON output when skill is not installed and --json is passed", async () => {
    /**
     * Tests that --json flag produces machine-readable error output.
     */

    // GIVEN no skills are installed
    // WHEN we run `vellum skills uninstall nonexistent --json`
    process.argv = [
      "bun",
      "run",
      "skills",
      "uninstall",
      "nonexistent",
      "--json",
    ];
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...args: unknown[]) => logs.push(args.join(" "));
    try {
      await skills();
    } finally {
      console.log = origLog;
    }

    // THEN JSON output should indicate failure
    const output = JSON.parse(logs[0]);
    expect(output.ok).toBe(false);
    expect(output.error).toContain('Skill "nonexistent" is not installed.');
  });

  test("works when SKILLS.md does not exist", async () => {
    /**
     * Tests that uninstall works even if the SKILLS.md index file is missing.
     */

    // GIVEN a skill directory exists but no SKILLS.md
    installFakeSkill("weather");

    // WHEN we run `vellum skills uninstall weather`
    process.argv = ["bun", "run", "skills", "uninstall", "weather"];
    await skills();

    // THEN the skill directory should be removed
    expect(existsSync(join(getSkillsDir(), "weather"))).toBe(false);

    // AND no SKILLS.md should have been created
    expect(existsSync(getSkillsIndexPath())).toBe(false);
  });

  test("removes skill with nested files", async () => {
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

    // WHEN we run `vellum skills uninstall weather`
    process.argv = ["bun", "run", "skills", "uninstall", "weather"];
    await skills();

    // THEN the entire skill directory tree should be removed
    expect(existsSync(skillDir)).toBe(false);

    // AND the SKILLS.md entry should be removed
    const index = readFileSync(getSkillsIndexPath(), "utf-8");
    expect(index).not.toContain("weather");
  });
});
