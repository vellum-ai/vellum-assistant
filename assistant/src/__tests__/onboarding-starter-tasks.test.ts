import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
  truncateForLog: (v: string) => v,
  initLogger: () => {},
  pruneOldLogFiles: () => 0,
}));

const { buildStarterTaskPlaybookSection, buildSystemPrompt } =
  await import("../prompts/system-prompt.js");

describe("buildStarterTaskPlaybookSection", () => {
  test("returns a string with the section heading", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("## Starter Task Playbooks");
  });

  test("documents all three kickoff intents", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("[STARTER_TASK:make_it_yours]");
    expect(section).toContain("[STARTER_TASK:research_topic]");
    expect(section).toContain("[STARTER_TASK:research_to_ui]");
  });

  test("includes the make_it_yours playbook", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("### Playbook: make_it_yours");
    expect(section).toContain("accent color");
    expect(section).toContain("Color Preference");
    expect(section).toContain("user_selected");
  });

  test("make_it_yours uses app_file_edit instead of invalid ui_show config_update", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("app_file_edit");
    expect(section).not.toContain("config_update");
    expect(section).not.toContain('surface_type: "config_update"');
  });

  test("includes the research_topic playbook", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("### Playbook: research_topic");
    expect(section).toContain("web search");
  });

  test("includes the research_to_ui playbook", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("### Playbook: research_to_ui");
    expect(section).toContain("app_create");
  });

  test("includes general rules section", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("### General rules for all starter tasks");
  });

  test("enforces trust gating in general rules", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("trust gating");
    expect(section).toContain("do NOT ask for elevated permissions");
  });

  test("references USER.md onboarding tasks for status tracking", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("## Onboarding Tasks");
    expect(section).toContain("in_progress");
    expect(section).toContain("done");
    expect(section).toContain("deferred_to_dashboard");
  });

  test("make_it_yours playbook handles locale confirmation", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("locale");
    expect(section).toContain("confidence: low");
  });

  test("make_it_yours playbook includes confirmation step", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("Confirm the selection");
    expect(section).toContain("Sound good?");
  });

  test("research_to_ui playbook references dynamic UI quality standards", () => {
    const section = buildStarterTaskPlaybookSection();
    expect(section).toContain("Dynamic UI quality standards");
    expect(section).toContain("anti-AI-slop");
  });
});

describe("starter task playbook integration with buildSystemPrompt", () => {
  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(TEST_DIR)) {
      rmSync(TEST_DIR, { recursive: true, force: true });
    }
  });

  test("buildSystemPrompt includes the starter task playbook section when BOOTSTRAP.md exists", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "# First run");
    const result = buildSystemPrompt();
    expect(result).toContain("## Starter Task Playbooks");
  });

  test("buildSystemPrompt omits starter task playbooks after onboarding is complete", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    // No BOOTSTRAP.md → onboarding complete
    const result = buildSystemPrompt();
    expect(result).not.toContain("## Starter Task Playbooks");
  });

  test("starter task playbook present during onboarding (channel awareness removed from static prompt)", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "# First run");
    const result = buildSystemPrompt();
    const starterIdx = result.indexOf("## Starter Task Playbooks");
    expect(starterIdx).toBeGreaterThan(-1);
    // Channel awareness section was removed from the static prompt —
    // channel-specific rules are now injected per-turn via <channel_capabilities>.
    expect(result).not.toContain("## Channel Awareness & Trust Gating");
  });

  test("all three kickoff intents present in full system prompt during onboarding", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    writeFileSync(join(TEST_DIR, "BOOTSTRAP.md"), "# First run");
    const result = buildSystemPrompt();
    expect(result).toContain("[STARTER_TASK:make_it_yours]");
    expect(result).toContain("[STARTER_TASK:research_topic]");
    expect(result).toContain("[STARTER_TASK:research_to_ui]");
  });

  test("system prompt does not contain invalid config_update surface type (bare)", () => {
    writeFileSync(join(TEST_DIR, "IDENTITY.md"), "I am Vellum.");
    const result = buildSystemPrompt();
    // voice_config_update is a valid tool name; only bare 'config_update' surface type is invalid
    expect(result).not.toContain('surface_type: "config_update"');
  });
});
