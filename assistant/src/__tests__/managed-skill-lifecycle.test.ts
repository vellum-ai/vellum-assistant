import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let TEST_DIR = "";

const mockConfig = {
  provider: "anthropic",
  model: "test",
  apiKeys: {},
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
  },
  sandbox: { enabled: false },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: {
    enabled: true,
    action: "warn" as const,
    entropyThreshold: 4.0,
  },
  auditLog: { retentionDays: 0 },
};

mock.module("../util/platform.js", () => ({
  getRootDir: () => TEST_DIR,
  getWorkspaceSkillsDir: () => join(TEST_DIR, "skills"),
  getDataDir: () => TEST_DIR,
  ensureDataDir: () => {},
  getSocketPath: () => join(TEST_DIR, "vellum.sock"),
  getPidPath: () => join(TEST_DIR, "vellum.pid"),
  getDbPath: () => join(TEST_DIR, "data", "assistant.db"),
  getLogPath: () => join(TEST_DIR, "logs", "vellum.log"),
  getHistoryPath: () => join(TEST_DIR, "history"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => process.platform,
  getClipboardCommand: () => null,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  saveConfig: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: (command: string, _workingDir: string, _config: unknown) => ({
    command: "bash",
    args: ["-c", "--", command],
    sandboxed: false,
  }),
}));

import {
  createSkillLocally,
  uninstallSkillLocally,
} from "../cli/commands/skills.js";
import { loadSkillCatalog } from "../config/skills.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { SkillLoadTool } from "../tools/skills/load.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test-session",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

function writeBodyFile(name: string, content: string): string {
  const bodyPath = join(TEST_DIR, name);
  writeFileSync(bodyPath, content);
  return bodyPath;
}

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("managed skill lifecycle: create -> catalog -> prompt -> delete", () => {
  test("full lifecycle: create skill, verify in catalog and prompt, then delete", () => {
    const skillMdPath = join(TEST_DIR, "skills", "lifecycle-test", "SKILL.md");
    const createdPath = createSkillLocally({
      skillId: "lifecycle-test",
      name: "Lifecycle Test",
      description: "Integration test skill.",
      bodyFile: writeBodyFile(
        "lifecycle-test.md",
        "Run the lifecycle test procedure.\n",
      ),
      emoji: "🧪",
    });

    expect(createdPath).toBe(skillMdPath);
    expect(existsSync(skillMdPath)).toBe(true);
    const skillContent = readFileSync(skillMdPath, "utf-8");
    expect(skillContent).toContain('name: "Lifecycle Test"');
    expect(skillContent).toContain('description: "Integration test skill."');
    expect(skillContent).toContain("Run the lifecycle test procedure.");

    const catalog = loadSkillCatalog();
    const found = catalog.find((s) => s.id === "lifecycle-test");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Lifecycle Test");
    expect(found!.description).toBe("Integration test skill.");

    const prompt = buildSystemPrompt();
    expect(prompt).toContain("lifecycle-test");
    expect(prompt).toContain("Lifecycle Test");
    expect(prompt).toContain("## Dynamic Skill Authoring Workflow");

    uninstallSkillLocally("lifecycle-test");

    expect(existsSync(skillMdPath)).toBe(false);

    const catalogAfter = loadSkillCatalog();
    expect(catalogAfter.find((s) => s.id === "lifecycle-test")).toBeUndefined();

    const indexPath = join(TEST_DIR, "skills", "SKILLS.md");
    if (existsSync(indexPath)) {
      const indexContent = readFileSync(indexPath, "utf-8");
      expect(indexContent).not.toContain("lifecycle-test");
    }
  });

  test("create with overwrite replaces existing skill", () => {
    createSkillLocally({
      skillId: "overwrite-test",
      name: "V1",
      description: "Version 1.",
      bodyFile: writeBodyFile("overwrite-v1.md", "Original body.\n"),
    });

    createSkillLocally({
      skillId: "overwrite-test",
      name: "V2",
      description: "Version 2.",
      bodyFile: writeBodyFile("overwrite-v2.md", "Updated body.\n"),
      overwrite: true,
    });

    const skillContent = readFileSync(
      join(TEST_DIR, "skills", "overwrite-test", "SKILL.md"),
      "utf-8",
    );
    expect(skillContent).toContain('name: "V2"');
    expect(skillContent).toContain("Updated body.");
    expect(skillContent).not.toContain("Original body.");

    const indexContent = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    const matches = indexContent.match(/overwrite-test/g);
    expect(matches?.length).toBe(1);
  });

  test("delete non-existent skill returns error", () => {
    expect(() => uninstallSkillLocally("does-not-exist")).toThrow(
      'Skill "does-not-exist" is not installed.',
    );
  });

  test("create -> skill_load chain: literal tool execution", async () => {
    const skillLoadTool = new (SkillLoadTool as any)() as InstanceType<
      typeof SkillLoadTool
    >;

    createSkillLocally({
      skillId: "chain-test",
      name: "Chain Test",
      description: "Created from local CLI.",
      bodyFile: writeBodyFile(
        "chain-test.md",
        "This skill was dynamically created.\n\nRun: `echo chain-test-ok`\n",
      ),
    });

    const loadResult = await skillLoadTool.execute(
      { skill: "chain-test" },
      makeContext(),
    );
    expect(loadResult.isError).not.toBe(true);
    const loadContent = loadResult.content as string;
    expect(loadContent).toContain("Skill: Chain Test");
    expect(loadContent).toContain("ID: chain-test");
    expect(loadContent).toContain("Description: Created from local CLI.");
    expect(loadContent).toContain("dynamically created");
    expect(loadContent).toContain("echo chain-test-ok");

    uninstallSkillLocally("chain-test");

    const loadAfterDelete = await skillLoadTool.execute(
      { skill: "chain-test" },
      makeContext(),
    );
    expect(loadAfterDelete.isError).toBe(true);
  });
});
