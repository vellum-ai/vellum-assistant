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

import { Command } from "commander";

import {
  createSkillLocally,
  registerSkillsCommand,
} from "../cli/commands/skills.js";

let tempDir: string;
let originalBaseDataDir: string | undefined;

function getSkillsDir(): string {
  return join(tempDir, ".vellum", "workspace", "skills");
}

function getSkillPath(skillId: string): string {
  return join(getSkillsDir(), skillId, "SKILL.md");
}

function getSkillsIndexPath(): string {
  return join(getSkillsDir(), "SKILLS.md");
}

function writeBodyFile(name: string, content: string): string {
  const bodyFile = join(tempDir, name);
  writeFileSync(bodyFile, content);
  return bodyFile;
}

async function runSkillsCli(
  args: string[],
): Promise<{ exitCode: number; stdout: string }> {
  const originalStdoutWrite = process.stdout.write.bind(process.stdout);
  const originalStderrWrite = process.stderr.write.bind(process.stderr);
  const stdoutChunks: string[] = [];

  process.stdout.write = ((chunk: unknown) => {
    stdoutChunks.push(typeof chunk === "string" ? chunk : String(chunk));
    return true;
  }) as typeof process.stdout.write;

  process.stderr.write = (() => true) as typeof process.stderr.write;
  process.exitCode = 0;

  try {
    const program = new Command();
    program.exitOverride();
    program.configureOutput({
      writeErr: () => {},
      writeOut: (str: string) => stdoutChunks.push(str),
    });
    registerSkillsCommand(program);
    await program.parseAsync(["node", "assistant", "skills", ...args]);
  } catch {
    if (process.exitCode === 0) process.exitCode = 1;
  } finally {
    process.stdout.write = originalStdoutWrite;
    process.stderr.write = originalStderrWrite;
  }

  const exitCode = process.exitCode ?? 0;
  process.exitCode = 0;

  return {
    exitCode,
    stdout: stdoutChunks.join(""),
  };
}

beforeEach(() => {
  tempDir = join(
    tmpdir(),
    `skills-create-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
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

describe("assistant skills create", () => {
  test("creates a local skill and updates SKILLS.md", () => {
    const bodyFile = writeBodyFile(
      "weather.md",
      "# Weather Helper\n\nAnswer weather questions.\n",
    );

    const skillPath = createSkillLocally({
      skillId: "weather-helper",
      name: "Weather Helper",
      description: "Answer weather questions.",
      bodyFile,
    });

    expect(skillPath).toBe(getSkillPath("weather-helper"));
    expect(existsSync(skillPath)).toBe(true);

    const skill = readFileSync(skillPath, "utf-8");
    expect(skill).toContain('name: "Weather Helper"');
    expect(skill).toContain('description: "Answer weather questions."');
    expect(skill).toContain("# Weather Helper");

    const index = readFileSync(getSkillsIndexPath(), "utf-8");
    expect(index).toContain("- weather-helper");
  });

  test("writes optional metadata fields", () => {
    const bodyFile = writeBodyFile(
      "incident.md",
      "# Incident Helper\n\nGuide incident response.\n",
    );

    createSkillLocally({
      skillId: "incident-helper",
      name: "Incident Helper",
      description: "Guide incident response.",
      bodyFile,
      emoji: "🚨",
      includes: ["browser", "terminal"],
      userInvocable: false,
      disableModelInvocation: true,
    });

    const skill = readFileSync(getSkillPath("incident-helper"), "utf-8");
    expect(skill).toContain('"emoji":"🚨"');
    expect(skill).toContain('"includes":["browser","terminal"]');
    expect(skill).toContain('"user-invocable":false');
    expect(skill).toContain('"disable-model-invocation":true');
  });

  test("rejects duplicates unless overwrite=true", () => {
    const v1 = writeBodyFile("v1.md", "Version 1.\n");
    const v2 = writeBodyFile("v2.md", "Version 2.\n");

    createSkillLocally({
      skillId: "duplicate-test",
      name: "Duplicate Test",
      description: "Version 1",
      bodyFile: v1,
    });

    expect(() =>
      createSkillLocally({
        skillId: "duplicate-test",
        name: "Duplicate Test",
        description: "Version 2",
        bodyFile: v2,
      }),
    ).toThrow('Managed skill "duplicate-test" already exists.');

    createSkillLocally({
      skillId: "duplicate-test",
      name: "Duplicate Test",
      description: "Version 2",
      bodyFile: v2,
      overwrite: true,
    });

    const skill = readFileSync(getSkillPath("duplicate-test"), "utf-8");
    expect(skill).toContain("Version 2.");
    expect(skill).not.toContain("Version 1.");
  });

  test("create --help documents arguments, behavior, and the resolved workspace path", async () => {
    const result = await runSkillsCli(["create", "--help"]);
    expect(result.stdout).toContain("Arguments:");
    expect(result.stdout).toContain("Behavior:");
    expect(result.stdout).toContain(getSkillsDir());
    expect(result.stdout).toContain("--body-file -");
  });
});
