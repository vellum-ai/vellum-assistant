import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

const TEST_DIR = join(
  tmpdir(),
  `vellum-starter-tasks-test-${crypto.randomUUID()}`,
);

import { mock } from "bun:test";

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getRootDir: () => TEST_DIR,
  getDataDir: () => TEST_DIR,
  getWorkspaceDir: () => TEST_DIR,
  getWorkspaceConfigPath: () => join(TEST_DIR, "config.json"),
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
  getWorkspaceHooksDir: () => join(TEST_DIR, "hooks"),
  getWorkspacePromptPath: (file: string) => join(TEST_DIR, file),
  ensureDataDir: () => {},
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  getHooksDir: () => join(TEST_DIR, "hooks"),

  getSandboxRootDir: () => join(TEST_DIR, "sandbox"),
  getSandboxWorkingDir: () => TEST_DIR,
  getInterfacesDir: () => join(TEST_DIR, "interfaces"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
  readSessionToken: () => null,
  readLockfile: () => null,
  writeLockfile: () => {},
}));

const noopLogger = new Proxy({} as Record<string, unknown>, {
  get: (_target, prop) => (prop === "child" ? () => noopLogger : () => {}),
});

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realLogger = require("../util/logger.js");
mock.module("../util/logger.js", () => ({
  ...realLogger,
  getLogger: () => noopLogger,
  getCliLogger: () => noopLogger,
  isDebug: () => false,
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const { resolveStarterTaskIntent } = await import(
  "../daemon/starter-task-intent.js"
);
const { buildSystemPrompt } = await import("../prompts/system-prompt.js");

// ---------------------------------------------------------------------------
// resolveStarterTaskIntent
// ---------------------------------------------------------------------------

describe("resolveStarterTaskIntent", () => {
  test("detects [STARTER_TASK:make_it_yours] and rewrites to skill load", () => {
    const result = resolveStarterTaskIntent("[STARTER_TASK:make_it_yours]");
    expect(result.kind).toBe("starter_task");
    if (result.kind === "starter_task") {
      expect(result.taskId).toBe("make_it_yours");
      expect(result.rewrittenContent).toContain("onboarding-starter-tasks");
      expect(result.rewrittenContent).toContain("skill_load");
      expect(result.rewrittenContent).toContain("make_it_yours");
    }
  });

  test("detects [STARTER_TASK:research_topic]", () => {
    const result = resolveStarterTaskIntent("[STARTER_TASK:research_topic]");
    expect(result.kind).toBe("starter_task");
    if (result.kind === "starter_task") {
      expect(result.taskId).toBe("research_topic");
      expect(result.rewrittenContent).toContain("research_topic");
    }
  });

  test("detects [STARTER_TASK:research_to_ui]", () => {
    const result = resolveStarterTaskIntent("[STARTER_TASK:research_to_ui]");
    expect(result.kind).toBe("starter_task");
    if (result.kind === "starter_task") {
      expect(result.taskId).toBe("research_to_ui");
      expect(result.rewrittenContent).toContain("research_to_ui");
    }
  });

  test("returns none for ordinary messages", () => {
    const result = resolveStarterTaskIntent("Hello, how are you?");
    expect(result.kind).toBe("none");
  });

  test("returns none for partial matches", () => {
    const result = resolveStarterTaskIntent(
      "Can you do [STARTER_TASK:make_it_yours] for me?",
    );
    expect(result.kind).toBe("none");
  });

  test("returns none for empty string", () => {
    const result = resolveStarterTaskIntent("");
    expect(result.kind).toBe("none");
  });

  test("handles whitespace around the kickoff message", () => {
    const result = resolveStarterTaskIntent(
      "  [STARTER_TASK:make_it_yours]  ",
    );
    expect(result.kind).toBe("starter_task");
  });

  test("returns none for unknown task IDs", () => {
    const result = resolveStarterTaskIntent("[STARTER_TASK:foo]");
    expect(result.kind).toBe("none");
  });

  test("returns none for typo in task ID", () => {
    const result = resolveStarterTaskIntent("[STARTER_TASK:make_it_your]");
    expect(result.kind).toBe("none");
  });
});

// ---------------------------------------------------------------------------
// SKILL.md existence and content
// ---------------------------------------------------------------------------

describe("onboarding-starter-tasks SKILL.md", () => {
  const skillPath = resolve(
    import.meta.dirname ?? __dirname,
    "../../../skills/onboarding-starter-tasks/SKILL.md",
  );

  test("SKILL.md file exists", () => {
    expect(existsSync(skillPath)).toBe(true);
  });

  test("SKILL.md contains all three playbooks", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("## Playbook: make_it_yours");
    expect(content).toContain("## Playbook: research_topic");
    expect(content).toContain("## Playbook: research_to_ui");
  });

  test("SKILL.md covers USER.md status updates", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("## Onboarding Tasks");
    expect(content).toContain("in_progress");
    expect(content).toContain("done");
    expect(content).toContain("deferred_to_dashboard");
  });

  test("SKILL.md covers trust gating", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("trust gating");
    expect(content).toContain("do NOT ask for elevated permissions");
  });

  test("SKILL.md covers locale confirmation for make_it_yours", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("locale");
    expect(content).toContain("confidence: low");
  });

  test("SKILL.md covers Dynamic UI quality for research_to_ui", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("Dynamic UI quality standards");
    expect(content).toContain("anti-AI-slop");
  });

  test("SKILL.md includes kickoff intent contract", () => {
    const content = readFileSync(skillPath, "utf-8");
    expect(content).toContain("[STARTER_TASK:make_it_yours]");
    expect(content).toContain("[STARTER_TASK:research_topic]");
    expect(content).toContain("[STARTER_TASK:research_to_ui]");
  });
});

// ---------------------------------------------------------------------------
// System prompt no longer embeds full playbooks
// ---------------------------------------------------------------------------

describe("system prompt starter task routing", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("system prompt contains routing section, not full playbooks", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    const result = buildSystemPrompt();
    expect(result).toContain("## Routing: Starter Tasks");
    expect(result).not.toContain("## Starter Task Playbooks");
    expect(result).not.toContain("### Playbook: make_it_yours");
    expect(result).not.toContain("### Playbook: research_topic");
    expect(result).not.toContain("### Playbook: research_to_ui");
  });

  test("system prompt routing section is present regardless of onboarding state", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "# First run");
    const result = buildSystemPrompt();
    expect(result).toContain("## Routing: Starter Tasks");
    // Full playbooks are NOT in the system prompt even during onboarding
    expect(result).not.toContain("### Playbook: make_it_yours");
  });

  test("system prompt does not contain invalid config_update surface type (bare)", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    const result = buildSystemPrompt();
    // voice_config_update is a valid tool name; only bare 'config_update' surface type is invalid
    expect(result).not.toContain('surface_type: "config_update"');
  });
});
