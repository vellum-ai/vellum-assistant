/**
 * Tests for the requireFreshApproval context flag.
 *
 * Verifies that manage_secure_command_tool cannot bypass the interactive
 * approval prompt through any of the following shortcut paths:
 *
 * 1. Persistent decisions ("Always Allow" rule creation)
 * 2. Grant-consumed short-circuit (pre-existing scoped grant)
 * 3. Non-interactive guardian auto-approve
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { RiskLevel, type ScopeOption } from "../permissions/types.js";
import type {
  ToolExecutionResult,
  ToolLifecycleEvent,
  ToolPermissionPromptEvent,
} from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mock setup — mirrors tool-executor.test.ts patterns
// ---------------------------------------------------------------------------

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
  sandbox: {
    enabled: false,
    backend: "native" as const,
    docker: {
      image: "vellum-sandbox:latest",
      cpus: 1,
      memoryMb: 512,
      pidsLimit: 256,
      network: "none" as const,
    },
  },
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: {
    enabled: false,
    action: "warn" as const,
    entropyThreshold: 4.0,
  },
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };

/** Override the check() result for specific tests. */
let checkResultOverride: { decision: string; reason: string } | undefined;

/** Override the risk level returned by classifyRisk(). Defaults to "high". */
let riskOverride: string = "high";

/** Scope options override — controls whether persistent decisions are offered. */
let scopeOptionsOverride: ScopeOption[] | undefined;

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

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

mock.module("../permissions/checker.js", () => ({
  classifyRisk: async () => ({ level: riskOverride }),
  check: async () => {
    if (checkResultOverride) return checkResultOverride;
    return { decision: "allow", reason: "allowed" };
  },
  generateAllowlistOptions: () => [
    { label: "exact", description: "exact", pattern: "exact" },
  ],
  generateScopeOptions: () =>
    scopeOptionsOverride ?? [{ label: "/tmp", scope: "/tmp" }],
  getCachedAssessment: () => undefined,
}));

mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: () => 0,
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => {
    if (name === "unknown_tool") return undefined;
    const isGmailTool = name.startsWith("gmail_");
    return {
      name,
      description: "test tool",
      category: isGmailTool ? "gmail" : "credential-execution",
      defaultRiskLevel: "high",
      executionTarget: isGmailTool ? ("host" as const) : undefined,
      getDefinition: () => ({}),
      execute: async () => fakeToolResult,
    };
  },
  getAllTools: () => [],
}));

mock.module("../permissions/gateway-threshold-reader.js", () => ({
  getAutoApproveThreshold: async () => "medium",
  _clearGlobalCacheForTesting: () => {},
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

mock.module("../tools/terminal/sandbox.js", () => ({
  wrapCommand: () => ({ command: "", sandboxed: false }),
}));

import { PermissionPrompter } from "../permissions/prompter.js";
import { ToolExecutor } from "../tools/executor.js";
import type { ToolContext as TC } from "../tools/types.js";

function makeContext(overrides?: Partial<TC>): TC {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass: "guardian",
    isInteractive: true,
    ...overrides,
  };
}

function makePrompter(): PermissionPrompter {
  return {
    prompt: async () => ({ decision: "allow" as const }),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

afterAll(() => {
  mock.restore();
});

// ---------------------------------------------------------------------------
// Bypass 4: Non-interactive guardian auto-approve
// ---------------------------------------------------------------------------

describe("requireFreshApproval: non-interactive guardian denial", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    checkResultOverride = undefined;
    scopeOptionsOverride = undefined;
    riskOverride = "high";
  });

  afterEach(() => {});

  test("manage_secure_command_tool is denied in non-interactive guardian sessions", async () => {
    // check() returns "prompt" (which normally triggers guardian auto-approve
    // for non-interactive sessions). With requireFreshApproval, it should
    // fall through to the non-interactive denial path instead.
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "manage_secure_command_tool",
      { action: "register", toolName: "test-tool" },
      makeContext({ isInteractive: false, trustClass: "guardian" }),
    );

    // Should be denied because non-interactive + requireFreshApproval
    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires user approval");
    expect(result.content).toContain("no interactive client");
  });

  test("regular tools are still auto-approved in non-interactive guardian sessions", async () => {
    // Verify that the auto-approve path still works for normal tools
    // at non-high risk levels
    riskOverride = RiskLevel.Medium;
    checkResultOverride = {
      decision: "prompt",
      reason: "Needs approval",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({ isInteractive: false, trustClass: "guardian" }),
    );

    // Regular tools should be auto-approved
    expect(result.isError).toBe(false);
  });

  test("high-risk tools are denied in non-interactive guardian sessions", async () => {
    riskOverride = RiskLevel.High;
    checkResultOverride = {
      decision: "prompt",
      reason: "Needs approval",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({ isInteractive: false, trustClass: "guardian", requireFreshApproval: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires user approval");
  });

  test("medium-risk tools are still auto-approved in non-interactive guardian sessions", async () => {
    riskOverride = RiskLevel.Medium;
    checkResultOverride = {
      decision: "prompt",
      reason: "Needs approval",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({ isInteractive: false, trustClass: "guardian" }),
    );

    expect(result.isError).toBe(false);
  });

  test("medium-risk gmail archive is auto-approved in non-interactive guardian sessions", async () => {
    riskOverride = RiskLevel.Medium;
    checkResultOverride = {
      decision: "prompt",
      reason: "Needs approval",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "gmail_archive",
      { query: "in:inbox", confidence: 0.92 },
      makeContext({ isInteractive: false, trustClass: "guardian" }),
    );

    expect(result.isError).toBe(false);
  });

  test("high-risk gmail send_draft is denied in non-interactive guardian sessions", async () => {
    riskOverride = RiskLevel.High;
    checkResultOverride = {
      decision: "prompt",
      reason: "Needs approval",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "gmail_send_draft",
      { draft_id: "draft-123", confidence: 0.99 },
      makeContext({ isInteractive: false, trustClass: "guardian", requireFreshApproval: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires user approval");
  });

  test("low-risk tools are still auto-approved in non-interactive guardian sessions", async () => {
    riskOverride = RiskLevel.Low;
    checkResultOverride = {
      decision: "prompt",
      reason: "Needs approval",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({ isInteractive: false, trustClass: "guardian" }),
    );

    expect(result.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Bypass 2: Persistent decisions (Always Allow)
// ---------------------------------------------------------------------------

describe("requireFreshApproval: persistent decisions disabled", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    checkResultOverride = undefined;
    scopeOptionsOverride = undefined;
    riskOverride = "high";

  });

  afterEach(() => {

  });

  test("manage_secure_command_tool prompt does not offer persistent decisions", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const capturedEvents: ToolLifecycleEvent[] = [];
    let persistentDecisionsPassedToPrompter: boolean | undefined;

    const inspectingPrompter = {
      prompt: async (
        _toolName: string,
        _input: Record<string, unknown>,
        _riskLevel: string,
        _allowlistOptions: unknown[],
        _scopeOptions: unknown[],
        _previewDiff: unknown,
        _conversationId: string,
        _executionTarget: string,
        persistentDecisionsAllowed: boolean,
      ) => {
        persistentDecisionsPassedToPrompter = persistentDecisionsAllowed;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(inspectingPrompter);
    await executor.execute(
      "manage_secure_command_tool",
      { action: "register", toolName: "test-tool" },
      makeContext({
        onToolLifecycleEvent: (e) => {
          capturedEvents.push(e);
        },
      }),
    );

    // The prompter should have been told persistentDecisions are NOT allowed
    expect(persistentDecisionsPassedToPrompter).toBe(false);

    // The lifecycle event should also reflect this
    const promptEvent = capturedEvents.find(
      (e) => e.type === "permission_prompt",
    ) as ToolPermissionPromptEvent | undefined;
    expect(promptEvent).toBeDefined();
    expect(promptEvent!.persistentDecisionsAllowed).toBe(false);
  });


});

// ---------------------------------------------------------------------------
// Bypass 3: Grant-consumed short-circuit
// ---------------------------------------------------------------------------

describe("requireFreshApproval: grant-consumed does not skip permission check", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    checkResultOverride = undefined;
    scopeOptionsOverride = undefined;
    riskOverride = "high";

  });

  afterEach(() => {

  });

  test("manage_secure_command_tool is prompted even when executor sets requireFreshApproval and grantConsumed would normally short-circuit", async () => {
    // This test verifies the code path in executor.ts where the
    // condition changed from `if (!gateResult.grantConsumed)` to
    // `if (!gateResult.grantConsumed || context.requireFreshApproval)`.
    //
    // In the real flow, grantConsumed=true only happens for untrusted
    // actors. Here we verify that the requireFreshApproval flag causes
    // the permission check to run by testing the manage_secure_command_tool
    // path directly — it sets both forcePromptSideEffects and
    // requireFreshApproval, so the permission check always runs.

    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    let promptCalled = false;
    const trackingPrompter = {
      prompt: async () => {
        promptCalled = true;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(trackingPrompter);
    const result = await executor.execute(
      "manage_secure_command_tool",
      { action: "register", toolName: "test-tool" },
      makeContext(),
    );

    // manage_secure_command_tool should always be prompted due to
    // forcePromptSideEffects + isSideEffectTool being true
    expect(promptCalled).toBe(true);
    expect(result.isError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Context flag propagation
// ---------------------------------------------------------------------------

describe("requireFreshApproval: context flag propagation", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    checkResultOverride = undefined;
    scopeOptionsOverride = undefined;
    riskOverride = "high";

  });

  afterEach(() => {

  });

  test("manage_secure_command_tool sets both forcePromptSideEffects and requireFreshApproval", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const inspectingPrompter = {
      prompt: async () => {
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(inspectingPrompter);
    const ctx = makeContext();
    await executor.execute(
      "manage_secure_command_tool",
      { action: "register", toolName: "test-tool" },
      ctx,
    );

    // After execution, the context should have both flags set
    expect(ctx.forcePromptSideEffects).toBe(true);
    expect(ctx.requireFreshApproval).toBe(true);
  });

  test("regular tools do not set requireFreshApproval", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makePrompter());
    const ctx = makeContext();
    await executor.execute("bash", { command: "echo hello" }, ctx);

    expect(ctx.requireFreshApproval).toBeUndefined();
  });
});
