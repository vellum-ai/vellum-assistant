import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

const testDir = process.env.VELLUM_WORKSPACE_DIR!;

// Point the file-based trust backend at the test temp dir.
process.env.GATEWAY_SECURITY_DIR = join(testDir, "protected");

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

const testConfig: Record<string, any> = {
  permissions: { mode: "workspace" as "strict" | "workspace" },
  skills: { load: { extraDirs: [] as string[] } },
  sandbox: { enabled: false },
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

import { check, classifyRisk } from "../permissions/checker.js";
import {
  addRule,
  clearCache,
  findHighestPriorityRule,
} from "../permissions/trust-store.js";
import type { PolicyContext, TrustRule } from "../permissions/types.js";
import {
  buildTaskRules,
  clearTaskRunRules,
  getTaskRunRules,
  setTaskRunRules,
} from "../tasks/ephemeral-permissions.js";

// Ensure the protected directory exists for trust-store disk operations
mkdirSync(join(testDir, "protected"), { recursive: true });

describe("ephemeral-permissions", () => {
  // Warm up the shell parser (loads WASM) — required before any check() call
  // that involves bash commands, otherwise the parser init may hang.
  beforeAll(async () => {
    await classifyRisk("bash", { command: "echo warmup" });
  });
  describe("buildTaskRules", () => {
    test("generates correct rule structure for each required tool", () => {
      const taskRunId = "run-123";
      const requiredTools = ["file_read", "bash", "file_write"];
      const workingDir = "/home/user/project";

      const rules = buildTaskRules(taskRunId, requiredTools, workingDir);

      expect(rules).toHaveLength(3);

      // Check the first rule in detail
      const fileReadRule = rules[0];
      expect(fileReadRule.id).toBe("ephemeral:run-123:file_read");
      expect(fileReadRule.tool).toBe("file_read");
      expect(fileReadRule.pattern).toBe("**");
      expect(fileReadRule.scope).toBe("everywhere");
      expect(fileReadRule.decision).toBe("allow");
      expect(fileReadRule.priority).toBe(75);
      expect(fileReadRule.createdAt).toBeGreaterThan(0);

      // Ephemeral task rules should not auto-allow high-risk tools
      // allowHighRisk is no longer a field on rules

      // Check other rules have correct tool names
      expect(rules[1].tool).toBe("bash");
      expect(rules[1].id).toBe("ephemeral:run-123:bash");
      expect(rules[2].tool).toBe("file_write");
      expect(rules[2].id).toBe("ephemeral:run-123:file_write");
    });

    test("returns empty array for empty required tools", () => {
      const rules = buildTaskRules("run-456", [], "/tmp");
      expect(rules).toHaveLength(0);
    });
  });

  describe("setTaskRunRules / getTaskRunRules / clearTaskRunRules", () => {
    beforeEach(() => {
      // Clean up any leftover state
      clearTaskRunRules("test-run-1");
      clearTaskRunRules("test-run-2");
    });

    test("returns empty array for unknown task run", () => {
      expect(getTaskRunRules("nonexistent")).toEqual([]);
    });

    test("stores and retrieves rules for a task run", () => {
      const rules = buildTaskRules("test-run-1", ["file_read"], "/tmp");
      setTaskRunRules("test-run-1", rules);

      const retrieved = getTaskRunRules("test-run-1");
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].tool).toBe("file_read");
    });

    test("clears rules for a task run", () => {
      const rules = buildTaskRules("test-run-1", ["file_read"], "/tmp");
      setTaskRunRules("test-run-1", rules);
      expect(getTaskRunRules("test-run-1")).toHaveLength(1);

      clearTaskRunRules("test-run-1");
      expect(getTaskRunRules("test-run-1")).toEqual([]);
    });

    test("isolates rules between task runs", () => {
      const rules1 = buildTaskRules("test-run-1", ["file_read"], "/tmp");
      const rules2 = buildTaskRules(
        "test-run-2",
        ["bash", "file_write"],
        "/home",
      );

      setTaskRunRules("test-run-1", rules1);
      setTaskRunRules("test-run-2", rules2);

      expect(getTaskRunRules("test-run-1")).toHaveLength(1);
      expect(getTaskRunRules("test-run-2")).toHaveLength(2);

      clearTaskRunRules("test-run-1");
      expect(getTaskRunRules("test-run-1")).toEqual([]);
      expect(getTaskRunRules("test-run-2")).toHaveLength(2);
    });
  });

  describe("findHighestPriorityRule with ephemeral rules", () => {
    beforeEach(() => {
      clearCache();
    });

    test("ephemeral rules are found by findHighestPriorityRule", () => {
      const ephemeralRules: TrustRule[] = [
        {
          id: "ephemeral:run-1:file_read",
          tool: "file_read",
          pattern: "**",
          scope: "/home/user/project",
          decision: "allow",
          priority: 50,
          createdAt: Date.now(),
        },
      ];

      const ctx: PolicyContext = {
        ephemeralRules,
      };

      const result = findHighestPriorityRule(
        "file_read",
        ["file_read:/home/user/project/foo.txt"],
        "/home/user/project",
        ctx,
      );

      expect(result).not.toBeNull();
      expect(result!.id).toBe("ephemeral:run-1:file_read");
      expect(result!.decision).toBe("allow");
    });

    test("user deny rules at higher priority override ephemeral allow rules", () => {
      // Add a persistent user deny rule with priority 100
      addRule("file_read", "**", "/home/user/project", "deny", 100);

      const ephemeralRules: TrustRule[] = [
        {
          id: "ephemeral:run-1:file_read",
          tool: "file_read",
          pattern: "**",
          scope: "/home/user/project",
          decision: "allow",
          priority: 50,
          createdAt: Date.now(),
        },
      ];

      const ctx: PolicyContext = {
        ephemeralRules,
      };

      const result = findHighestPriorityRule(
        "file_read",
        ["file_read:/home/user/project/foo.txt"],
        "/home/user/project",
        ctx,
      );

      expect(result).not.toBeNull();
      // The user deny rule (priority 100) should win over the ephemeral allow (priority 50)
      expect(result!.decision).toBe("deny");
    });

    test("ephemeral rules do not match when scope is outside working dir", () => {
      const ephemeralRules: TrustRule[] = [
        {
          id: "ephemeral:run-1:file_read",
          tool: "file_read",
          pattern: "**",
          scope: "/home/user/project",
          decision: "allow",
          priority: 50,
          createdAt: Date.now(),
        },
      ];

      const ctx: PolicyContext = {
        ephemeralRules,
      };

      // Query with a different scope that doesn't match the ephemeral rule's scope
      const result = findHighestPriorityRule(
        "file_read",
        ["file_read:/other/path/foo.txt"],
        "/other/path",
        ctx,
      );

      // Should not match the ephemeral rule (scope mismatch)
      // May or may not match a default rule
      if (result) {
        expect(result.id).not.toBe("ephemeral:run-1:file_read");
      }
    });
  });

  describe("check() with ephemeral rules", () => {
    beforeEach(() => {
      clearCache();
      testConfig.permissions.mode = "workspace";
    });

    test("ephemeral allow rule auto-allows non-high-risk tool", async () => {
      const ephemeralRules: TrustRule[] = [
        {
          id: "ephemeral:run-1:file_read",
          tool: "file_read",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 50,
          createdAt: Date.now(),
        },
      ];

      const ctx: PolicyContext = {
        ephemeralRules,
      };

      // Use testDir (a real temp path) to avoid EPERM on macOS /home
      const fakePath = join(testDir, "foo.txt");
      const result = await check("file_read", { path: fakePath }, testDir, ctx);

      expect(result.decision).toBe("allow");
    });

    test("high-risk tool still prompts even with ephemeral allow rule", async () => {
      const ephemeralRules: TrustRule[] = [
        {
          id: "ephemeral:run-1:bash",
          tool: "bash",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 50,
          createdAt: Date.now(),
          // allowHighRisk is no longer a field
        },
      ];

      const ctx: PolicyContext = {
        ephemeralRules,
      };

      // sudo is high-risk
      const result = await check(
        "bash",
        { command: "sudo rm -rf /" },
        "/home/user/project",
        ctx,
      );

      expect(result.decision).toBe("prompt");
    });
  });

  // ── Canonical shape and scope fallback semantics ──────────────────
  //
  // Validates that ephemeral rules follow canonical persisted shapes
  // and that optional scope behaves correctly as a fallback.

  describe("canonical shape and scope fallback semantics", () => {
    beforeEach(() => {
      clearCache();
    });

    test("ephemeral rule with scope 'everywhere' matches from any working directory", () => {
      // Use a tool (host_file_read) that has no default allow rule and a
      // high priority so the ephemeral rule wins over the default ask rule.
      const ephemeralRules: TrustRule[] = [
        {
          id: "ephemeral:run-scope:host_file_read",
          tool: "host_file_read",
          pattern: "**",
          scope: "everywhere",
          decision: "allow",
          priority: 2000,
          createdAt: Date.now(),
        },
      ];

      const ctx: PolicyContext = { ephemeralRules };

      // Should match from /tmp
      const r1 = findHighestPriorityRule(
        "host_file_read",
        ["host_file_read:/tmp/foo.txt"],
        "/tmp",
        ctx,
      );
      expect(r1).not.toBeNull();
      expect(r1!.id).toBe("ephemeral:run-scope:host_file_read");

      // Should match from /home/user/project
      const r2 = findHighestPriorityRule(
        "host_file_read",
        ["host_file_read:/home/user/project/bar.ts"],
        "/home/user/project",
        ctx,
      );
      expect(r2).not.toBeNull();
      expect(r2!.id).toBe("ephemeral:run-scope:host_file_read");
    });

    test("ephemeral rule does not carry stray metadata fields for non-scoped tools", () => {
      // buildTaskRules generates canonical ephemeral rules.
      // For a tool like file_read (scoped family), the generated rule
      // should have no executionTarget.
      const rules = buildTaskRules("run-canon", ["file_read", "bash"], "/tmp");

      for (const rule of rules) {
        expect(rule.scope).toBe("everywhere");
        expect(rule.allowHighRisk).toBeUndefined();
        expect(rule.executionTarget).toBeUndefined();
      }
    });

    test("ephemeral rule with project scope does not match sibling project", () => {
      const ephemeralRules: TrustRule[] = [
        {
          id: "ephemeral:run-proj:file_write",
          tool: "file_write",
          pattern: "**",
          scope: "/home/user/project-a",
          decision: "allow",
          priority: 75,
          createdAt: Date.now(),
        },
      ];

      const ctx: PolicyContext = { ephemeralRules };

      // Should NOT match from a sibling directory
      const result = findHighestPriorityRule(
        "file_write",
        ["file_write:/home/user/project-b/file.ts"],
        "/home/user/project-b",
        ctx,
      );

      // The ephemeral rule should not be the match (scope mismatch)
      if (result) {
        expect(result.id).not.toBe("ephemeral:run-proj:file_write");
      }
    });
  });

  describe("workspace mode interactions", () => {
    beforeEach(() => {
      clearCache();
      testConfig.permissions.mode = "workspace";
    });

    afterEach(() => {
      testConfig.permissions.mode = "workspace";
    });

    test("workspace mode auto-allows workspace-scoped file_write (low risk)", async () => {
      const filePath = join(testDir, "workspace-test-file.txt");
      const result = await check("file_write", { path: filePath }, testDir);
      expect(result.decision).toBe("allow");
    });

    test("workspace mode auto-allows file_write outside workspace (low risk)", async () => {
      const result = await check(
        "file_write",
        { path: "/etc/config" },
        testDir,
      );
      expect(result.decision).toBe("allow");
    });

    test("explicit deny rule overrides workspace mode auto-allow", async () => {
      addRule("file_write", "**", testDir, "deny", 100);
      const filePath = join(testDir, "should-be-denied.txt");
      const result = await check("file_write", { path: filePath }, testDir);
      expect(result.decision).toBe("deny");
    });

    test("proxied bash follows normal rules in workspace mode (no special-casing)", async () => {
      const result = await check(
        "bash",
        { command: "echo hello", network_mode: "proxied" },
        testDir,
      );
      // Default allow-bash rule auto-allows; proxied mode is not special-cased.
      expect(result.decision).toBe("allow");
    });

    test("ephemeral task rules + workspace mode: deny rule wins", async () => {
      // Add a persistent deny rule for file_write in the workspace
      addRule("file_write", "**", testDir, "deny", 100);

      // Create ephemeral allow rules (lower priority than deny)
      const ephemeralRules: TrustRule[] = [
        {
          id: "ephemeral:run-ws:file_write",
          tool: "file_write",
          pattern: "**",
          scope: testDir,
          decision: "allow",
          priority: 50,
          createdAt: Date.now(),
        },
      ];

      const ctx: PolicyContext = {
        ephemeralRules,
      };

      const filePath = join(testDir, "task-file.txt");
      const result = await check(
        "file_write",
        { path: filePath },
        testDir,
        ctx,
      );
      // The persistent deny rule (priority 100) should override
      // both the ephemeral allow (priority 50) and workspace mode auto-allow
      expect(result.decision).toBe("deny");
    });
  });
});
