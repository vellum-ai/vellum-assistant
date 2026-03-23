import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "trusted-auto-approve-test-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
  getWorkspaceDir: () => join(testDir, "workspace"),
  getWorkspaceDirDisplay: () => join(testDir, "workspace"),
  getWorkspaceSkillsDir: () => join(testDir, "workspace", "skills"),
  getWorkspaceConfigPath: () => join(testDir, "workspace", "config.json"),
  getWorkspaceHooksDir: () => join(testDir, "workspace", "hooks"),
  getWorkspacePromptPath: (file: string) =>
    join(testDir, "workspace", "prompts", file),
  getConversationsDir: () => join(testDir, "conversations"),
  getHooksDir: () => join(testDir, "hooks"),
  getSignalsDir: () => join(testDir, "signals"),
  getHistoryPath: () => join(testDir, "history"),
  getInterfacesDir: () => join(testDir, "interfaces"),
  getSandboxRootDir: () => join(testDir, "sandbox"),
  getSandboxWorkingDir: () => join(testDir, "sandbox", "work"),
  getSoundsDir: () => join(testDir, "sounds"),
  getEmbeddingModelsDir: () => join(testDir, "embedding-models"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPlatformName: () => "test",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
  getTCPPort: () => 0,
  isTCPEnabled: () => false,
  getTCPHost: () => "127.0.0.1",
  isIOSPairingEnabled: () => false,
  getPlatformTokenPath: () => join(testDir, "token"),
  readPlatformToken: () => null,
  getClipboardCommand: () => null,
  resolveInstanceDataDir: () => undefined,
  normalizeAssistantId: (id: string) => id,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

mock.module("../tools/verification-control-plane-policy.js", () => ({
  enforceVerificationControlPlanePolicy: () => ({ denied: false }),
}));

mock.module("../tasks/ephemeral-permissions.js", () => ({
  getTaskRunRules: () => [],
}));

// Mock config
mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    permissions: { dangerouslySkipPermissions: false },
    sandbox: { enabled: false },
    timeouts: { permissionTimeoutSec: 30 },
    secretDetection: { allowOneTimeSend: false },
  }),
}));

// Mock hooks
mock.module("../hooks/manager.js", () => ({
  getHookManager: () => ({
    trigger: async () => {},
  }),
}));

// Mock conversation approval overrides
mock.module("../runtime/conversation-approval-overrides.js", () => ({
  getEffectiveMode: () => undefined,
  setTimedMode: () => {},
  setConversationMode: () => {},
}));

// Mock permission checker
mock.module("../permissions/checker.js", () => ({
  check: async () => ({ decision: "prompt", reason: "needs approval" }),
  classifyRisk: async () => "low",
  generateAllowlistOptions: async () => [],
  generateScopeOptions: () => [],
  normalizeWebFetchUrl: (url: string) => url,
}));

// Mock policy context
mock.module("../tools/policy-context.js", () => ({
  buildPolicyContext: () => null,
}));

// Mock side effects
mock.module("../tools/side-effects.js", () => ({
  isSideEffectTool: (name: string) => name !== "read_only_tool",
}));

// Mock sandbox
mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: () => ({ sandboxed: false }),
}));

// Mock channel permission profiles
mock.module("../channels/permission-profiles.js", () => ({
  isToolAllowedInChannel: () => true,
}));

import { initializeDb, resetDb } from "../memory/db.js";
import { RiskLevel } from "../permissions/types.js";
import type { Tool, ToolContext, ToolLifecycleEvent } from "../tools/types.js";

// Initialize the DB so ToolApprovalHandler tests can use grant tables
initializeDb();

// ── Helper factories ─────────────────────────────────────────────────

function makeTool(overrides: Partial<Tool> = {}): Tool {
  return {
    name: overrides.name ?? "test_tool",
    description: "Test tool",
    category: "test",
    defaultRiskLevel: overrides.defaultRiskLevel ?? RiskLevel.Low,
    trustedAutoApprove: overrides.trustedAutoApprove ?? false,
    getDefinition: () => ({
      name: overrides.name ?? "test_tool",
      description: "Test tool",
      input_schema: { type: "object" as const, properties: {} },
    }),
    execute: async () => ({ content: "ok", isError: false }),
    ...overrides,
  };
}

function makeToolContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: testDir,
    conversationId: "test-conv",
    trustClass: overrides.trustClass ?? "trusted_contact",
    isInteractive: overrides.isInteractive ?? false,
    requireFreshApproval: overrides.requireFreshApproval ?? false,
    ...overrides,
  };
}

const noopEmit = (_event: ToolLifecycleEvent): void => {};
const noopSanitize = (_name: string, input: Record<string, unknown>) => input;
const noopDiff = () => undefined;

// ── Tests ────────────────────────────────────────────────────────────

describe("trusted_auto_approve", () => {
  // ─── Permission Checker tests ────────────────────────────────────

  describe("PermissionChecker", () => {
    // We need to dynamically import after mocks are set up
    let PermissionChecker: typeof import("../tools/permission-checker.js").PermissionChecker;

    beforeEach(async () => {
      const mod = await import("../tools/permission-checker.js");
      PermissionChecker = mod.PermissionChecker;
    });

    const mockPrompter = {
      prompt: async () => ({ decision: "allow" as const }),
      dispose: () => {},
    };

    test("trustedAutoApprove: true + low risk + trusted_contact + non-interactive → auto-approved", async () => {
      const checker = new PermissionChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Low,
      });
      const context = makeToolContext({
        trustClass: "trusted_contact",
        isInteractive: false,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      expect(result.allowed).toBe(true);
      expect(result.decision).toBe("trusted_auto_approve");
    });

    test("trustedAutoApprove: true + low risk + trusted_contact + interactive → auto-approved", async () => {
      const checker = new PermissionChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Low,
      });
      const context = makeToolContext({
        trustClass: "trusted_contact",
        isInteractive: true,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      expect(result.allowed).toBe(true);
      expect(result.decision).toBe("trusted_auto_approve");
    });

    test("trustedAutoApprove: true + medium risk + trusted_contact + non-interactive → denied (risk cap)", async () => {
      const checker = new PermissionChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Medium,
      });
      const context = makeToolContext({
        trustClass: "trusted_contact",
        isInteractive: false,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      // Should NOT be trusted_auto_approve because risk is medium
      expect(result.decision).not.toBe("trusted_auto_approve");
    });

    test("trustedAutoApprove: true + medium risk + trusted_contact + interactive → denied (risk cap)", async () => {
      const checker = new PermissionChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Medium,
      });
      const context = makeToolContext({
        trustClass: "trusted_contact",
        isInteractive: true,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      expect(result.decision).not.toBe("trusted_auto_approve");
    });

    test("trustedAutoApprove: true + low risk + unknown + non-interactive → denied", async () => {
      const checker = new PermissionChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Low,
      });
      const context = makeToolContext({
        trustClass: "unknown",
        isInteractive: false,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      expect(result.decision).not.toBe("trusted_auto_approve");
      expect(result.allowed).toBe(false);
    });

    test("trustedAutoApprove: true + low risk + unknown + interactive → denied", async () => {
      const checker = new PermissionChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Low,
      });
      const context = makeToolContext({
        trustClass: "unknown",
        isInteractive: true,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      expect(result.decision).not.toBe("trusted_auto_approve");
    });

    test("trustedAutoApprove: false + low risk + trusted_contact + non-interactive → denied (flag required)", async () => {
      const checker = new PermissionChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: false,
        defaultRiskLevel: RiskLevel.Low,
      });
      const context = makeToolContext({
        trustClass: "trusted_contact",
        isInteractive: false,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      expect(result.decision).not.toBe("trusted_auto_approve");
      expect(result.allowed).toBe(false);
    });

    test("trustedAutoApprove: true + low risk + guardian + non-interactive → guardian_auto_approve (unchanged)", async () => {
      const checker = new PermissionChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Low,
      });
      const context = makeToolContext({
        trustClass: "guardian",
        isInteractive: false,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      expect(result.allowed).toBe(true);
      expect(result.decision).toBe("guardian_auto_approve");
    });

    test("trustedAutoApprove: true + low risk + trusted_contact + requireFreshApproval → denied", async () => {
      const checker = new PermissionChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Low,
      });
      const context = makeToolContext({
        trustClass: "trusted_contact",
        isInteractive: false,
        requireFreshApproval: true,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      expect(result.decision).not.toBe("trusted_auto_approve");
      expect(result.allowed).toBe(false);
    });

    test("trustedAutoApprove: true + low risk + trusted_contact + dynamic skill load → denied", async () => {
      // Override the check mock to return a matched rule with skill_load_dynamic pattern
      mock.module("../permissions/checker.js", () => ({
        check: async () => ({
          decision: "prompt",
          reason: "needs approval",
          matchedRule: { pattern: "skill_load_dynamic:test" },
        }),
        classifyRisk: async () => "low",
        generateAllowlistOptions: async () => [],
        generateScopeOptions: () => [],
        normalizeWebFetchUrl: (url: string) => url,
      }));

      // Re-import to get the new mock
      const { PermissionChecker: FreshChecker } =
        await import("../tools/permission-checker.js");
      const checker = new FreshChecker(mockPrompter as any);
      const tool = makeTool({
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Low,
      });
      const context = makeToolContext({
        trustClass: "trusted_contact",
        isInteractive: false,
      });

      const result = await checker.checkPermission(
        "test_tool",
        {},
        tool,
        context,
        "host",
        noopEmit,
        noopSanitize,
        Date.now(),
        noopDiff,
      );

      expect(result.decision).not.toBe("trusted_auto_approve");
      expect(result.allowed).toBe(false);

      // Restore original mock
      mock.module("../permissions/checker.js", () => ({
        check: async () => ({ decision: "prompt", reason: "needs approval" }),
        classifyRisk: async () => "low",
        generateAllowlistOptions: async () => [],
        generateScopeOptions: () => [],
        normalizeWebFetchUrl: (url: string) => url,
      }));
    });
  });

  // ─── Tool Approval Handler (pre-exec gate) tests ────────────────

  describe("ToolApprovalHandler pre-exec gate", () => {
    let registeredTools: Map<string, Tool>;

    beforeEach(() => {
      registeredTools = new Map();
    });

    // Override tool registry mock with tools that have trustedAutoApprove
    function setupToolRegistry(tools: Tool[]) {
      registeredTools.clear();
      for (const t of tools) registeredTools.set(t.name, t);
      mock.module("../tools/registry.js", () => ({
        getTool: (name: string) => registeredTools.get(name),
        getAllTools: () => Array.from(registeredTools.values()),
      }));
    }

    test("trusted_contact + trustedAutoApprove + low risk → skips grant consumption", async () => {
      const tool = makeTool({
        name: "auto_like",
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Low,
      });
      setupToolRegistry([tool]);

      const { ToolApprovalHandler } =
        await import("../tools/tool-approval-handler.js");
      const handler = new ToolApprovalHandler();
      const context = makeToolContext({
        trustClass: "trusted_contact",
        isInteractive: true,
      });

      const result = await handler.checkPreExecutionGates(
        "auto_like",
        {},
        context,
        "host",
        "low",
        Date.now(),
        noopEmit,
      );

      expect(result.allowed).toBe(true);
      if (result.allowed) {
        // No grant should have been consumed
        expect(result.grantConsumed).toBeUndefined();
      }
    });

    test("trusted_contact + trustedAutoApprove + medium risk → still requires grant", async () => {
      const tool = makeTool({
        name: "risky_tool",
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Medium,
      });
      setupToolRegistry([tool]);

      const { ToolApprovalHandler } =
        await import("../tools/tool-approval-handler.js");
      const handler = new ToolApprovalHandler();
      const context = makeToolContext({
        trustClass: "trusted_contact",
        isInteractive: false,
      });

      const result = await handler.checkPreExecutionGates(
        "risky_tool",
        {},
        context,
        "host",
        "medium",
        Date.now(),
        noopEmit,
      );

      // Without a grant, should be denied
      expect(result.allowed).toBe(false);
    });

    test("unknown + trustedAutoApprove + low risk → denied (unknown actors fully blocked)", async () => {
      const tool = makeTool({
        name: "auto_like",
        trustedAutoApprove: true,
        defaultRiskLevel: RiskLevel.Low,
      });
      setupToolRegistry([tool]);

      const { ToolApprovalHandler } =
        await import("../tools/tool-approval-handler.js");
      const handler = new ToolApprovalHandler();
      const context = makeToolContext({
        trustClass: "unknown",
        isInteractive: false,
      });

      const result = await handler.checkPreExecutionGates(
        "auto_like",
        {},
        context,
        "host",
        "low",
        Date.now(),
        noopEmit,
      );

      expect(result.allowed).toBe(false);
    });
  });
});

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});
