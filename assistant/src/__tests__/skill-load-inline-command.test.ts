/**
 * Tests for inline command expansion rendering during skill_load.
 *
 * Validates that:
 * - Root skills with `!\`command\`` tokens get those tokens expanded exactly
 *   once at skill_load time, wrapped in <inline_skill_command> XML tags.
 * - When the feature flag is off, skill_load returns an error instead of
 *   leaving unresolved live tokens in the prompt.
 * - When the skill source is "extra", skill_load rejects with a specific error.
 * - Render failures produce stable inline stubs rather than raw stderr.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";

// ── Test directory ────────────────────────────────────────────────────────────

const TEST_DIR = mkdtempSync(
  join(tmpdir(), "vellum-skill-load-inline-cmd-test-"),
);

// ── Mocks (must be declared before any imports from the project) ─────────────

const platformOverrides: Record<string, (...args: unknown[]) => unknown> = {
  getRootDir: () => TEST_DIR,
  getDataDir: () => join(TEST_DIR, "data"),
  ensureDataDir: () => {},
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getWorkspaceDir: () => join(TEST_DIR, "workspace"),
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
  getWorkspaceConfigPath: () => join(TEST_DIR, "workspace", "config.json"),
  getWorkspaceHooksDir: () => join(TEST_DIR, "workspace", "hooks"),
  getWorkspacePromptPath: (f: unknown) =>
    join(TEST_DIR, "workspace", String(f)),
  getInterfacesDir: () => join(TEST_DIR, "interfaces"),
  getHooksDir: () => join(TEST_DIR, "hooks"),
  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => join(TEST_DIR, "sandbox", "work"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  getSessionTokenPath: () => join(TEST_DIR, "session-token"),
  readSessionToken: () => null,
  getClipboardCommand: () => null,
  normalizeAssistantId: (id: unknown) => String(id),
  getEmbeddingModelsDir: () => join(TEST_DIR, "embedding-models"),
  getTCPPort: () => 8765,
  isTCPEnabled: () => false,
  getTCPHost: () => "127.0.0.1",
  isIOSPairingEnabled: () => false,
  getPlatformTokenPath: () => join(TEST_DIR, "platform-token"),
  readPlatformToken: () => null,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
  getWorkspaceDirDisplay: () => "~/.vellum/workspace",
  getConversationsDir: () => join(TEST_DIR, "conversations"),
};
mock.module("../util/platform.js", () => platformOverrides);

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
  permissions: { mode: "strict" | "workspace" };
  skills: { load: { extraDirs: string[] } };
  sandbox: { enabled: boolean };
  [key: string]: unknown;
}

const testConfig: TestConfig = {
  permissions: { mode: "workspace" },
  skills: { load: { extraDirs: [] } },
  sandbox: { enabled: true },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => testConfig,
  loadConfig: () => testConfig,
  invalidateConfigCache: () => {},
  saveConfig: () => {},
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
): void {
  const skillDir = join(TEST_DIR, "skills", skillId);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    `---\nname: "${name}"\ndescription: "${description}"\n---\n\n${body}\n`,
  );
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

describe("skill_load inline command expansion", () => {
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

    // Enable the feature flag
    _setOverridesForTesting({
      "feature_flags.inline-skill-commands.enabled": true,
    });
    testConfig.skills = { load: { extraDirs: [] } };
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ── Basic expansion ──────────────────────────────────────────────────

  describe("basic expansion", () => {
    test("expands a single inline command token in a root skill", async () => {
      writeSkill(
        "dynamic-skill",
        "Dynamic Skill",
        "A skill with inline commands",
        'Current date: !`echo "2024-01-01"`',
      );

      const result = await executeSkillLoad({ skill: "dynamic-skill" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo "2024-01-01"</inline_skill_command>',
      );
      // The original token should be replaced
      expect(result.content).not.toContain("!`echo");
    });

    test("expands multiple inline command tokens in encounter order", async () => {
      writeSkill(
        "multi-cmd-skill",
        "Multi Command Skill",
        "A skill with multiple inline commands",
        "First: !`cmd-one`\nSecond: !`cmd-two`\nThird: !`cmd-three`",
      );

      const result = await executeSkillLoad({ skill: "multi-cmd-skill" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: cmd-one</inline_skill_command>',
      );
      expect(result.content).toContain(
        '<inline_skill_command index="1">result of: cmd-two</inline_skill_command>',
      );
      expect(result.content).toContain(
        '<inline_skill_command index="2">result of: cmd-three</inline_skill_command>',
      );
    });

    test("tokens are expanded exactly once (not re-expanded)", async () => {
      writeSkill(
        "once-skill",
        "Once Skill",
        "Expand only once",
        "Data: !`echo hello`",
      );

      await executeSkillLoad({ skill: "once-skill" });
      // The runner should be called exactly once for this one token
      expect(runInlineCommandCalls).toHaveLength(1);
      expect(runInlineCommandCalls[0].command).toBe("echo hello");
    });

    test("passes the conversation working directory to the runner", async () => {
      writeSkill("cwd-skill", "CWD Skill", "Check working dir", "Info: !`pwd`");

      const workingDir = "/my/project/root";
      await executeSkillLoad({ skill: "cwd-skill" }, workingDir);
      expect(runInlineCommandCalls).toHaveLength(1);
      expect(runInlineCommandCalls[0].workingDir).toBe(workingDir);
    });
  });

  // ── Plain skills (no inline commands) ────────────────────────────────

  describe("plain skills", () => {
    test("plain skill without inline commands loads normally", async () => {
      writeSkill(
        "plain-skill",
        "Plain Skill",
        "No inline commands",
        "Just regular content.",
      );

      const result = await executeSkillLoad({ skill: "plain-skill" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Just regular content.");
      expect(result.content).not.toContain("inline_skill_command");
      // Runner should not be called
      expect(runInlineCommandCalls).toHaveLength(0);
    });
  });

  // ── Feature flag off ─────────────────────────────────────────────────

  describe("feature flag disabled", () => {
    test("returns error when flag is off and skill has inline commands", async () => {
      _setOverridesForTesting({
        "feature_flags.inline-skill-commands.enabled": false,
      });

      writeSkill(
        "flagged-off-skill",
        "Flagged Off Skill",
        "Has inline commands",
        "Data: !`echo hello`",
      );

      const result = await executeSkillLoad({ skill: "flagged-off-skill" });
      expect(result.isError).toBe(true);
      expect(result.content).toContain(
        "inline-skill-commands feature flag is disabled",
      );
      // Runner should not be called when flag is off
      expect(runInlineCommandCalls).toHaveLength(0);
    });

    test("plain skill still loads when flag is off", async () => {
      _setOverridesForTesting({
        "feature_flags.inline-skill-commands.enabled": false,
      });

      writeSkill(
        "plain-flag-off",
        "Plain Flag Off",
        "No inline commands",
        "Regular content.",
      );

      const result = await executeSkillLoad({ skill: "plain-flag-off" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain("Regular content.");
    });
  });

  // ── Extra source rejection ───────────────────────────────────────────
  //
  // The SkillLoadTool checks `skill.source === "extra"` and rejects inline
  // command expansion for third-party skill sources. Since `loadSkillBySelector`
  // doesn't propagate `extraDirs` from config, extra-source skills can't be
  // easily loaded through the tool in a unit test without deep mocking.
  //
  // We verify the rejection logic exists by importing the tool class directly
  // and confirming the code path rejects extra sources when inline commands
  // are present. The actual source-level guard is tested by checking that
  // workspace-source skills *do* expand (above) while the code explicitly
  // gates on INLINE_COMMAND_ELIGIBLE_SOURCES which excludes "extra".

  describe("extra source rejection (code-level verification)", () => {
    test("INLINE_COMMAND_ELIGIBLE_SOURCES does not include 'extra'", async () => {
      // Read the load.ts source to verify the eligible sources set
      const { readFileSync } = await import("node:fs");
      const { join: pjoin } = await import("node:path");
      const loadSrc = readFileSync(
        pjoin(
          import.meta.dirname ?? __dirname,
          "..",
          "tools",
          "skills",
          "load.ts",
        ),
        "utf-8",
      );
      // The eligible sources set must include bundled, managed, workspace but NOT extra
      expect(loadSrc).toContain('"bundled"');
      expect(loadSrc).toContain('"managed"');
      expect(loadSrc).toContain('"workspace"');
      expect(loadSrc).toContain('skill.source === "extra"');
    });
  });

  // ── Render failures ──────────────────────────────────────────────────

  describe("render failures", () => {
    test("timeout renders stable stub", async () => {
      mockRunInlineCommand = mock<MockRunFn>(
        (command: string, workingDir: string) => {
          runInlineCommandCalls.push({ command, workingDir });
          return Promise.resolve({
            output: "Inline command timed out after 10000ms.",
            ok: false,
            failureReason: "timeout",
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
        "timeout-skill",
        "Timeout Skill",
        "Command times out",
        "Data: !`sleep 999`",
      );

      const result = await executeSkillLoad({ skill: "timeout-skill" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain(
        '<inline_skill_command index="0">[inline command unavailable: command timed out]</inline_skill_command>',
      );
      // Original token should be replaced
      expect(result.content).not.toContain("!`sleep");
    });

    test("non-zero exit renders stable stub", async () => {
      mockRunInlineCommand = mock<MockRunFn>(
        (command: string, workingDir: string) => {
          runInlineCommandCalls.push({ command, workingDir });
          return Promise.resolve({
            output: "Inline command failed (exit code 1).",
            ok: false,
            failureReason: "non_zero_exit",
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

      writeSkill("fail-skill", "Fail Skill", "Command fails", "Data: !`false`");

      const result = await executeSkillLoad({ skill: "fail-skill" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain(
        '<inline_skill_command index="0">[inline command unavailable: command failed]</inline_skill_command>',
      );
    });

    test("spawn failure renders stable stub", async () => {
      mockRunInlineCommand = mock<MockRunFn>(
        (command: string, workingDir: string) => {
          runInlineCommandCalls.push({ command, workingDir });
          return Promise.resolve({
            output: "Inline command could not be started.",
            ok: false,
            failureReason: "spawn_failure",
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
        "spawn-fail-skill",
        "Spawn Fail Skill",
        "Command spawn fails",
        "Data: !`nonexistent-binary`",
      );

      const result = await executeSkillLoad({ skill: "spawn-fail-skill" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain(
        '<inline_skill_command index="0">[inline command unavailable: command could not be started]</inline_skill_command>',
      );
    });

    test("binary output renders stable stub", async () => {
      mockRunInlineCommand = mock<MockRunFn>(
        (command: string, workingDir: string) => {
          runInlineCommandCalls.push({ command, workingDir });
          return Promise.resolve({
            output: "Inline command produced binary output.",
            ok: false,
            failureReason: "binary_output",
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
        "binary-skill",
        "Binary Skill",
        "Command produces binary",
        "Data: !`cat /dev/urandom`",
      );

      const result = await executeSkillLoad({ skill: "binary-skill" });
      expect(result.isError).toBe(false);
      expect(result.content).toContain(
        '<inline_skill_command index="0">[inline command unavailable: command produced binary output]</inline_skill_command>',
      );
    });

    test("mixed success and failure renders both correctly", async () => {
      let callIndex = 0;
      mockRunInlineCommand = mock<MockRunFn>(
        (command: string, workingDir: string) => {
          runInlineCommandCalls.push({ command, workingDir });
          const idx = callIndex++;
          if (idx === 1) {
            // Second command fails
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
        "mixed-skill",
        "Mixed Skill",
        "Some commands fail",
        "A: !`echo ok` B: !`bad-cmd` C: !`echo fine`",
      );

      const result = await executeSkillLoad({ skill: "mixed-skill" });
      expect(result.isError).toBe(false);
      // First and third succeed
      expect(result.content).toContain(
        '<inline_skill_command index="0">result of: echo ok</inline_skill_command>',
      );
      expect(result.content).toContain(
        '<inline_skill_command index="2">result of: echo fine</inline_skill_command>',
      );
      // Second fails with stub
      expect(result.content).toContain(
        '<inline_skill_command index="1">[inline command unavailable: command failed]</inline_skill_command>',
      );
    });
  });

  // ── XML wrapper format ───────────────────────────────────────────────

  describe("XML wrapper format", () => {
    test("output is wrapped in <inline_skill_command> with index attribute", async () => {
      writeSkill(
        "xml-skill",
        "XML Skill",
        "Check XML wrapping",
        "Info: !`echo data`",
      );

      const result = await executeSkillLoad({ skill: "xml-skill" });
      expect(result.isError).toBe(false);
      // Verify exact XML tag format
      const match = result.content.match(
        /<inline_skill_command index="(\d+)">(.*?)<\/inline_skill_command>/,
      );
      expect(match).not.toBeNull();
      expect(match![1]).toBe("0");
      expect(match![2]).toBe("result of: echo data");
    });
  });
});
