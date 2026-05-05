/**
 * Tests for inline command expansion rendering in *included* child skills
 * during skill_load.
 *
 * Validates that:
 * - A root skill's included children with `!\`command\`` tokens get those
 *   tokens expanded at skill_load time through the same sandbox-only renderer
 *   used for root skills.
 * - Multiple children with a mix of inline-command and static bodies are all
 *   rendered correctly, preserving existing include ordering.
 * - A child-render failure is confined to that child's substituted block and
 *   does not corrupt sibling skill output.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Test directory ────────────────────────────────────────────────────────────

const TEST_DIR = process.env.VELLUM_WORKSPACE_DIR!;

// ── Mocks (must be declared before any imports from the project) ─────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (s: unknown) => String(s),
}));

// Track inline command runner calls
interface RunInlineCommandCall {
  command: string;
  workingDir: string;
}
const runInlineCommandCalls: RunInlineCommandCall[] = [];

/** Return type matching InlineCommandResult from the runner module. */
interface MockInlineCommandResult {
  output: string;
  ok: boolean;
  failureReason?:
    | "timeout"
    | "non_zero_exit"
    | "binary_output"
    | "spawn_failure";
}

type MockRunFn = (
  command: string,
  workingDir: string,
) => Promise<MockInlineCommandResult>;

// Default mock: commands succeed with their command string echoed
let mockRunInlineCommand = mock<MockRunFn>(
  (command: string, workingDir: string) => {
    runInlineCommandCalls.push({ command, workingDir });
    return Promise.resolve({
      output: `result of: ${command}`,
      ok: true,
    });
  },
);

mock.module("../skills/inline-command-runner.js", () => ({
  runInlineCommand: (command: string, workingDir: string, _options?: unknown) =>
    mockRunInlineCommand(command, workingDir),
}));

// Mock autoInstallFromCatalog
const mockAutoInstall = mock((_skillId: string) => Promise.resolve(false));
mock.module("../skills/catalog-install.js", () => ({
  autoInstallFromCatalog: (skillId: string) => mockAutoInstall(skillId),
  resolveCatalog: (_skillId?: string) => Promise.resolve([]),
}));

interface TestConfig {
  permissions: { autoApproveUpTo?: "none" | "low" | "medium" | "high" };
  skills: { load: { extraDirs: string[] } };
  sandbox: { enabled: boolean };
  [key: string]: unknown;
}

const testConfig: TestConfig = {
  permissions: {},
  skills: { load: { extraDirs: [] } },
  sandbox: { enabled: true },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => testConfig,
  loadConfig: () => testConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────

await import("../tools/skills/load.js");
const { getTool } = await import("../tools/registry.js");

// ── Helpers ───────────────────────────────────────────────────────────────

function writeSkill(
  skillId: string,
  name: string,
  description: string,
  body: string,
  options?: { includes?: string[] },
): void {
  const skillDir = join(TEST_DIR, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });

  let frontmatter = `---\nname: "${name}"\ndescription: "${description}"`;
  if (options?.includes && options.includes.length > 0) {
    frontmatter += `\nmetadata:\n  vellum:\n    includes:\n`;
    for (const inc of options.includes) {
      frontmatter += `      - "${inc}"\n`;
    }
  }
  frontmatter += `\n---\n\n`;

  writeFileSync(join(skillDir, "SKILL.md"), `${frontmatter}${body}\n`);
}

async function executeSkillLoad(
  input: Record<string, unknown>,
  workingDir = "/tmp",
): Promise<{ content: string; isError: boolean }> {
  const tool = getTool("skill_load");
  if (!tool) throw new Error("skill_load tool was not registered");

  const result = await tool.execute(input, {
    workingDir,
    conversationId: "conversation-1",
    trustClass: "guardian",
  });
  return { content: result.content, isError: result.isError };
}

// ── Tests ─────────────────────────────────────────────────────────────────

describe("skill_load inline command expansion for included skills", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
    runInlineCommandCalls.length = 0;
    mockAutoInstall.mockReset();
    mockAutoInstall.mockImplementation(() => Promise.resolve(false));

    // Reset to default: commands succeed
    mockRunInlineCommand = mock<MockRunFn>(
      (command: string, workingDir: string) => {
        runInlineCommandCalls.push({ command, workingDir });
        return Promise.resolve({
          output: `result of: ${command}`,
          ok: true,
        });
      },
    );
    mock.module("../skills/inline-command-runner.js", () => ({
      runInlineCommand: (
        command: string,
        workingDir: string,
        _options?: unknown,
      ) => mockRunInlineCommand(command, workingDir),
    }));

    testConfig.skills = { load: { extraDirs: [] } };
  });

  // ── Single inline-command child ──────────────────────────────────────

  describe("single inline-command child", () => {
    test("included child with inline commands gets tokens expanded", async () => {
      writeSkill(
        "child-dynamic",
        "Child Dynamic",
        "A child with inline commands",
        'Current env: !`echo "production"`',
      );
      writeSkill(
        "parent-skill",
        "Parent Skill",
        "A parent that includes a dynamic child",
        "Parent body content.",
        { includes: ["child-dynamic"] },
      );

      const result = await executeSkillLoad({ skill: "parent-skill" });
      expect(result.isError).toBe(false);
      // The child's inline command should be expanded
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo "production"</inline_skill_command>',
      );
      // The raw token should not appear
      expect(result.content).not.toContain('!`echo "production"`');
      // Parent body should still be present
      expect(result.content).toContain("Parent body content.");
    });

    test("passes conversation working directory to child inline command runner", async () => {
      writeSkill(
        "child-cwd",
        "Child CWD",
        "Check cwd forwarding",
        "Info: !`pwd`",
      );
      writeSkill(
        "parent-cwd",
        "Parent CWD",
        "Parent for cwd test",
        "Parent body.",
        { includes: ["child-cwd"] },
      );

      const workingDir = "/my/project/root";
      await executeSkillLoad({ skill: "parent-cwd" }, workingDir);
      expect(runInlineCommandCalls.length).toBeGreaterThanOrEqual(1);
      const pwdCall = runInlineCommandCalls.find((c) => c.command === "pwd");
      expect(pwdCall).toBeDefined();
      expect(pwdCall!.workingDir).toBe(workingDir);
    });
  });

  // ── Multiple children: mixed inline and static ───────────────────────

  describe("multiple children with mixed bodies", () => {
    test("renders inline commands in dynamic children while leaving static children unchanged", async () => {
      writeSkill(
        "child-static",
        "Static Child",
        "A static child",
        "Just plain static content.",
      );
      writeSkill(
        "child-dynamic-a",
        "Dynamic Child A",
        "Dynamic child A",
        "Version: !`echo v1`",
      );
      writeSkill(
        "child-dynamic-b",
        "Dynamic Child B",
        "Dynamic child B",
        "Host: !`hostname`",
      );
      writeSkill(
        "parent-mixed",
        "Parent Mixed",
        "Parent with mixed children",
        "Root body content.",
        { includes: ["child-static", "child-dynamic-a", "child-dynamic-b"] },
      );

      const result = await executeSkillLoad({ skill: "parent-mixed" });
      expect(result.isError).toBe(false);

      // Static child should appear unchanged
      expect(result.content).toContain("Just plain static content.");

      // Dynamic child A should have its token expanded
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo v1</inline_skill_command>',
      );
      expect(result.content).not.toContain("!`echo v1`");

      // Dynamic child B should have its token expanded
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: hostname</inline_skill_command>',
      );
      expect(result.content).not.toContain("!`hostname`");
    });

    test("preserves include ordering in output", async () => {
      writeSkill("child-first", "First Child", "First child", "First body.");
      writeSkill(
        "child-second",
        "Second Child",
        "Second child",
        "Data: !`echo second`",
      );
      writeSkill("child-third", "Third Child", "Third child", "Third body.");
      writeSkill(
        "parent-ordered",
        "Parent Ordered",
        "Parent with ordered includes",
        "Root.",
        { includes: ["child-first", "child-second", "child-third"] },
      );

      const result = await executeSkillLoad({ skill: "parent-ordered" });
      expect(result.isError).toBe(false);

      // Verify ordering: first appears before second, second before third
      const firstIdx = result.content.indexOf(
        "--- Included Skill: First Child",
      );
      const secondIdx = result.content.indexOf(
        "--- Included Skill: Second Child",
      );
      const thirdIdx = result.content.indexOf(
        "--- Included Skill: Third Child",
      );
      expect(firstIdx).toBeGreaterThan(-1);
      expect(secondIdx).toBeGreaterThan(-1);
      expect(thirdIdx).toBeGreaterThan(-1);
      expect(firstIdx).toBeLessThan(secondIdx);
      expect(secondIdx).toBeLessThan(thirdIdx);
    });
  });

  // ── Child render failures are isolated ───────────────────────────────

  describe("child render failure isolation", () => {
    test("a failing child command renders a stub without corrupting siblings", async () => {
      mockRunInlineCommand = mock<MockRunFn>(
        (command: string, workingDir: string) => {
          runInlineCommandCalls.push({ command, workingDir });
          // The "bad-cmd" command fails; others succeed
          if (command === "bad-cmd") {
            return Promise.resolve({
              output: "Inline command failed (exit code 1).",
              ok: false,
              failureReason: "non_zero_exit",
            });
          }
          return Promise.resolve({
            output: `result of: ${command}`,
            ok: true,
          });
        },
      );
      mock.module("../skills/inline-command-runner.js", () => ({
        runInlineCommand: (
          command: string,
          workingDir: string,
          _options?: unknown,
        ) => mockRunInlineCommand(command, workingDir),
      }));

      writeSkill(
        "child-ok",
        "OK Child",
        "Successful child",
        "Info: !`echo success`",
      );
      writeSkill(
        "child-fail",
        "Failing Child",
        "Failing child",
        "Data: !`bad-cmd`",
      );
      writeSkill(
        "child-ok-too",
        "Also OK Child",
        "Another successful child",
        "More: !`echo also-ok`",
      );
      writeSkill(
        "parent-isolated",
        "Parent Isolated",
        "Tests failure isolation",
        "Root content.",
        { includes: ["child-ok", "child-fail", "child-ok-too"] },
      );

      const result = await executeSkillLoad({ skill: "parent-isolated" });
      expect(result.isError).toBe(false);

      // OK child's command should be expanded successfully
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo success</inline_skill_command>',
      );

      // Failing child's command should show a failure stub
      expect(result.content).toContain(
        '<inline_skill_command index="0">[inline command unavailable: command failed]</inline_skill_command>',
      );

      // Also-OK child's command should be expanded successfully
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo also-ok</inline_skill_command>',
      );

      // Root content should be intact
      expect(result.content).toContain("Root content.");
    });

    test("a child with mixed success/failure renders both correctly", async () => {
      mockRunInlineCommand = mock<MockRunFn>(
        (command: string, workingDir: string) => {
          runInlineCommandCalls.push({ command, workingDir });
          // Fail the second command within this child
          if (command === "fail-me") {
            return Promise.resolve({
              output: "timed out",
              ok: false,
              failureReason: "timeout",
            });
          }
          return Promise.resolve({
            output: `result of: ${command}`,
            ok: true,
          });
        },
      );
      mock.module("../skills/inline-command-runner.js", () => ({
        runInlineCommand: (
          command: string,
          workingDir: string,
          _options?: unknown,
        ) => mockRunInlineCommand(command, workingDir),
      }));

      writeSkill(
        "child-mixed-cmds",
        "Mixed Commands Child",
        "Child with mixed results",
        "A: !`echo ok` B: !`fail-me` C: !`echo fine`",
      );
      writeSkill(
        "parent-mixed-child",
        "Parent Mixed Child",
        "Parent with mixed-result child",
        "Root.",
        { includes: ["child-mixed-cmds"] },
      );

      const result = await executeSkillLoad({ skill: "parent-mixed-child" });
      expect(result.isError).toBe(false);

      // First and third succeed
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo ok</inline_skill_command>',
      );
      expect(result.content).toContain(
        '<inline_skill_command index="2">result of: echo fine</inline_skill_command>',
      );
      // Second fails with timeout stub
      expect(result.content).toContain(
        '<inline_skill_command index="1">[inline command unavailable: command timed out]</inline_skill_command>',
      );
    });

    test("render exception in one child does not prevent sibling rendering", async () => {
      // Simulate a child whose renderInlineCommands call throws an exception
      mockRunInlineCommand = mock<MockRunFn>(
        (command: string, workingDir: string) => {
          runInlineCommandCalls.push({ command, workingDir });
          if (command === "crash-cmd") {
            // Simulate a throw inside the runner
            throw new Error("Simulated runner crash");
          }
          return Promise.resolve({
            output: `result of: ${command}`,
            ok: true,
          });
        },
      );
      mock.module("../skills/inline-command-runner.js", () => ({
        runInlineCommand: (
          command: string,
          workingDir: string,
          _options?: unknown,
        ) => mockRunInlineCommand(command, workingDir),
      }));

      writeSkill(
        "child-crash",
        "Crashing Child",
        "Child that crashes",
        "Data: !`crash-cmd`",
      );
      writeSkill(
        "child-healthy",
        "Healthy Child",
        "Healthy child",
        "Info: !`echo healthy`",
      );
      writeSkill(
        "parent-crash-test",
        "Parent Crash Test",
        "Tests exception isolation",
        "Root body.",
        { includes: ["child-crash", "child-healthy"] },
      );

      const result = await executeSkillLoad({ skill: "parent-crash-test" });
      expect(result.isError).toBe(false);

      // The crashing child should fall back to raw body (the try/catch in
      // load.ts catches the exception and leaves the body unmodified)
      expect(result.content).toContain("--- Included Skill: Crashing Child");

      // The healthy child should still have its inline command expanded
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo healthy</inline_skill_command>',
      );

      // Root body intact
      expect(result.content).toContain("Root body.");
    });
  });

  // ── Root with inline + child with inline ──────────────────────────────

  describe("root and child both have inline commands", () => {
    test("both root and child inline commands are expanded", async () => {
      writeSkill(
        "child-both",
        "Child Both",
        "Child with inline",
        "Child data: !`echo child-output`",
      );
      writeSkill(
        "parent-both",
        "Parent Both",
        "Parent with inline",
        "Root data: !`echo root-output`",
        { includes: ["child-both"] },
      );

      const result = await executeSkillLoad({ skill: "parent-both" });
      expect(result.isError).toBe(false);

      // Root inline command expanded
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo root-output</inline_skill_command>',
      );
      // Child inline command expanded
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo child-output</inline_skill_command>',
      );
      // No raw tokens
      expect(result.content).not.toContain("!`echo root-output`");
      expect(result.content).not.toContain("!`echo child-output`");
    });
  });
});
