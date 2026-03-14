import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

let TEST_DIR = "";

const mockConfig = {
  provider: "anthropic",
  model: "test",
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

import { loadSkillCatalog } from "../config/skills.js";
import { buildSystemPrompt } from "../prompts/system-prompt.js";
import { executeDeleteManagedSkill } from "../tools/skills/delete-managed.js";
import { SkillLoadTool } from "../tools/skills/load.js";
import { executeScaffoldManagedSkill } from "../tools/skills/scaffold-managed.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(): ToolContext {
  return {
    workingDir: "/tmp",
    sessionId: "test-session",
    conversationId: "test-conversation",
    trustClass: "guardian",
  };
}

beforeEach(() => {
  TEST_DIR = mkdtempSync(join(tmpdir(), "lifecycle-test-"));
  mkdirSync(join(TEST_DIR, "skills"), { recursive: true });
});

afterEach(() => {
  rmSync(TEST_DIR, { recursive: true, force: true });
});

describe("managed skill lifecycle: scaffold → catalog → prompt → delete", () => {
  test("full lifecycle: create skill, verify in catalog and prompt, then delete", async () => {
    // Step 1: Scaffold a managed skill
    const scaffoldResult = await executeScaffoldManagedSkill(
      {
        skill_id: "lifecycle-test",
        name: "Lifecycle Test",
        description: "Integration test skill.",
        body_markdown: "Run the lifecycle test procedure.",
        emoji: "🧪",
      },
      makeContext(),
    );

    expect(scaffoldResult.isError).not.toBe(true);
    const scaffoldData = JSON.parse(scaffoldResult.content as string);
    expect(scaffoldData.created).toBe(true);

    // Step 2: Verify SKILL.md was written
    const skillMdPath = join(TEST_DIR, "skills", "lifecycle-test", "SKILL.md");
    expect(existsSync(skillMdPath)).toBe(true);
    const skillContent = readFileSync(skillMdPath, "utf-8");
    expect(skillContent).toContain('name: "Lifecycle Test"');
    expect(skillContent).toContain('description: "Integration test skill."');
    expect(skillContent).toContain("Run the lifecycle test procedure.");

    // Step 3: Verify skill appears in catalog
    const catalog = loadSkillCatalog();
    const found = catalog.find((s) => s.id === "lifecycle-test");
    expect(found).toBeDefined();
    expect(found!.name).toBe("Lifecycle Test");
    expect(found!.description).toBe("Integration test skill.");

    // Step 4: Verify skill appears in system prompt
    const prompt = buildSystemPrompt();
    expect(prompt).toContain("lifecycle-test");
    expect(prompt).toContain("Lifecycle Test");
    expect(prompt).toContain("## Dynamic Skill Authoring Workflow");

    // Step 5: Delete the skill
    const deleteResult = await executeDeleteManagedSkill(
      {
        skill_id: "lifecycle-test",
      },
      makeContext(),
    );

    expect(deleteResult.isError).not.toBe(true);
    const deleteData = JSON.parse(deleteResult.content as string);
    expect(deleteData.deleted).toBe(true);

    // Step 6: Verify skill is gone from filesystem
    expect(existsSync(skillMdPath)).toBe(false);

    // Step 7: Verify skill no longer in catalog
    const catalogAfter = loadSkillCatalog();
    expect(catalogAfter.find((s) => s.id === "lifecycle-test")).toBeUndefined();

    // Step 8: Verify SKILLS.md index no longer has the entry
    const indexPath = join(TEST_DIR, "skills", "SKILLS.md");
    if (existsSync(indexPath)) {
      const indexContent = readFileSync(indexPath, "utf-8");
      expect(indexContent).not.toContain("lifecycle-test");
    }
  });

  test("scaffold with overwrite replaces existing skill", async () => {
    const ctx = makeContext();

    // Create initial skill
    await executeScaffoldManagedSkill(
      {
        skill_id: "overwrite-test",
        name: "V1",
        description: "Version 1.",
        body_markdown: "Original body.",
      },
      ctx,
    );

    // Overwrite with updated content
    const result = await executeScaffoldManagedSkill(
      {
        skill_id: "overwrite-test",
        name: "V2",
        description: "Version 2.",
        body_markdown: "Updated body.",
        overwrite: true,
      },
      ctx,
    );

    expect(result.isError).not.toBe(true);

    const skillContent = readFileSync(
      join(TEST_DIR, "skills", "overwrite-test", "SKILL.md"),
      "utf-8",
    );
    expect(skillContent).toContain('name: "V2"');
    expect(skillContent).toContain("Updated body.");
    expect(skillContent).not.toContain("Original body.");

    // Index should still have exactly one entry
    const indexContent = readFileSync(
      join(TEST_DIR, "skills", "SKILLS.md"),
      "utf-8",
    );
    const matches = indexContent.match(/overwrite-test/g);
    expect(matches?.length).toBe(1);
  });

  test("delete non-existent skill returns error", async () => {
    const result = await executeDeleteManagedSkill(
      {
        skill_id: "does-not-exist",
      },
      makeContext(),
    );

    expect(result.isError).toBe(true);
  });

  test("scaffold → skill_load chain: literal tool execution", async () => {
    const ctx = makeContext();

    const skillLoadTool = new (SkillLoadTool as any)() as InstanceType<
      typeof SkillLoadTool
    >;

    // Step 1: Scaffold a skill directly
    const scaffoldResult = await executeScaffoldManagedSkill(
      {
        skill_id: "chain-test",
        name: "Chain Test",
        description: "Created from scaffold.",
        body_markdown:
          "This skill was dynamically created.\n\nRun: `echo chain-test-ok`",
      },
      ctx,
    );

    expect(scaffoldResult.isError).not.toBe(true);
    const scaffoldData = JSON.parse(scaffoldResult.content as string);
    expect(scaffoldData.created).toBe(true);

    // Step 2: Call skill_load tool to load the created skill
    const loadResult = await skillLoadTool.execute(
      { skill: "chain-test" },
      ctx,
    );
    expect(loadResult.isError).not.toBe(true);
    const loadContent = loadResult.content as string;
    expect(loadContent).toContain("Skill: Chain Test");
    expect(loadContent).toContain("ID: chain-test");
    expect(loadContent).toContain("Description: Created from scaffold.");
    expect(loadContent).toContain("dynamically created");
    expect(loadContent).toContain("echo chain-test-ok");

    // Step 3: Clean up
    const deleteResult = await executeDeleteManagedSkill(
      { skill_id: "chain-test" },
      ctx,
    );
    expect(deleteResult.isError).not.toBe(true);

    // Step 4: Verify skill_load returns error for deleted skill
    const loadAfterDelete = await skillLoadTool.execute(
      { skill: "chain-test" },
      ctx,
    );
    expect(loadAfterDelete.isError).toBe(true);
  });
});
