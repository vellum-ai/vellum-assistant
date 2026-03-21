/**
 * Tests that vellum-self-knowledge uses inline command expansion to inject
 * the current assistant info at skill_load time.
 *
 * Validates that:
 * - The `!\`bun run .../self-info.ts\`` token in SKILL.md is replaced by an
 *   `<inline_skill_command>` block containing the runner's output.
 * - The rest of the skill body (architecture, config, references, critical rule)
 *   remains unchanged.
 * - The inline command token does NOT appear verbatim in the loaded output
 *   (i.e. the model is never told to shell out manually).
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ── Paths ──────────────────────────────────────────────────────────────────

const TEST_DIR = mkdtempSync(
  join(tmpdir(), "vellum-self-knowledge-inline-test-"),
);

/** Resolve the real skill directory so we can copy SKILL.md into the test. */
const SKILL_SRC_DIR = join(
  import.meta.dirname ?? __dirname,
  "..",
  "..",
  "..",
  "skills",
  "vellum-self-knowledge",
);

// ── Mocks (must be declared before any imports from the project) ──────────

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
  readLockfile: () => null,
  normalizeAssistantId: (id: unknown) => String(id),
  writeLockfile: () => {},
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

// Default: commands succeed, returning a realistic self-info summary
const MOCK_SELF_INFO_OUTPUT =
  "You are running as Claude Opus 4.6 via Anthropic (your-own API key).";

let mockRunInlineCommand = mock<MockRunFn>(
  (command: string, workingDir: string) => {
    runInlineCommandCalls.push({ command, workingDir });
    return Promise.resolve({
      output: MOCK_SELF_INFO_OUTPUT,
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

// ── Imports (after mocks) ────────────────────────────────────────────────

await import("../tools/skills/load.js");
const { getTool } = await import("../tools/registry.js");
const { _setOverridesForTesting, clearFeatureFlagOverridesCache } =
  await import("../config/assistant-feature-flags.js");

// ── Helpers ──────────────────────────────────────────────────────────────

/** Copy the real vellum-self-knowledge SKILL.md into the test skills dir. */
function installSelfKnowledgeSkill(): void {
  const destDir = join(TEST_DIR, "skills", "vellum-self-knowledge");
  mkdirSync(destDir, { recursive: true });
  copyFileSync(join(SKILL_SRC_DIR, "SKILL.md"), join(destDir, "SKILL.md"));
  // Also copy references/ so that the reference listing still works
  const refsSrc = join(SKILL_SRC_DIR, "references");
  if (existsSync(refsSrc)) {
    const refsDir = join(destDir, "references");
    mkdirSync(refsDir, { recursive: true });
    copyFileSync(join(refsSrc, "inference.md"), join(refsDir, "inference.md"));
  }
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

// ── Tests ────────────────────────────────────────────────────────────────

describe("vellum-self-knowledge inline command expansion", () => {
  beforeEach(() => {
    mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
    runInlineCommandCalls.length = 0;
    mockAutoInstall.mockReset();
    mockAutoInstall.mockImplementation(() => Promise.resolve(false));

    // Reset to default: commands succeed with self-info output
    mockRunInlineCommand = mock<MockRunFn>(
      (command: string, workingDir: string) => {
        runInlineCommandCalls.push({ command, workingDir });
        return Promise.resolve({
          output: MOCK_SELF_INFO_OUTPUT,
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

    // Enable the feature flag via protected directory override
    _setOverridesForTesting({
      "feature_flags.inline-skill-commands.enabled": true,
    });
    testConfig.skills = { load: { extraDirs: [] } };

    installSelfKnowledgeSkill();
  });

  afterEach(() => {
    clearFeatureFlagOverridesCache();
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  // ── Inline token replacement ─────────────────────────────────────────

  test("inline token is replaced by an <inline_skill_command> block", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain(
      `<inline_skill_command index="0">${MOCK_SELF_INFO_OUTPUT}</inline_skill_command>`,
    );
  });

  test("the raw inline token does not appear in the loaded output", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.isError).toBe(false);
    // The original `!\`...\`` token must be fully replaced
    expect(result.content).not.toContain("!`bun run");
    expect(result.content).not.toContain("scripts/self-info.ts`");
  });

  test("the model is not told to shell out manually", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.isError).toBe(false);
    // The old instruction "Always run this script" should be gone
    expect(result.content).not.toContain("Always run this script");
    // No code block instructing manual execution
    expect(result.content).not.toContain("```bash\nbun run");
  });

  // ── Runner invocation ────────────────────────────────────────────────

  test("invokes the inline command runner with the self-info script command", async () => {
    await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(runInlineCommandCalls).toHaveLength(1);
    expect(runInlineCommandCalls[0].command).toContain("bun run");
    expect(runInlineCommandCalls[0].command).toContain("scripts/self-info.ts");
  });

  // ── Rest of skill body preserved ─────────────────────────────────────

  test("architecture section is preserved", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("## Architecture at a Glance");
    expect(result.content).toContain("AgentLoop");
  });

  test("configuration section is preserved", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("## Configuration System");
    expect(result.content).toContain("assistant config get");
  });

  test("references section is preserved", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("## When to Consult References");
    expect(result.content).toContain("references/inference.md");
  });

  test("critical rule section is preserved", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("## Critical Rule");
    expect(result.content).toContain(
      "populated at skill-load time and reflects the live configuration",
    );
  });

  test("what is vellum section is preserved", async () => {
    const result = await executeSkillLoad({ skill: "vellum-self-knowledge" });
    expect(result.isError).toBe(false);
    expect(result.content).toContain("## What is Vellum");
    expect(result.content).toContain("personal AI assistant platform");
  });
});
