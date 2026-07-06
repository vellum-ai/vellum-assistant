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
  },
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };

/** Override the check() result for specific tests. */
let checkResultOverride: { decision: string; reason: string } | undefined;

/** Override the risk level returned by classifyRisk(). Defaults to "high". */
let riskOverride: string = "high";

/** Scope options override — controls whether persistent decisions are offered. */
let scopeOptionsOverride: ScopeOption[] | undefined;

/**
 * Auto-approve threshold returned to the permission checker. "high" is the
 * full-access posture under which the requireFreshApproval promotion is
 * skipped; every lower value still promotes allow → prompt.
 */
let thresholdOverride: "none" | "low" | "medium" | "high" = "medium";

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
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

/**
 * Sentinel cell query the mocked checker returns. When set, the permission
 * checker must thread it into every gateway threshold read for the
 * invocation — including the non-interactive guardian background read.
 */
let cellQueryOverride: Record<string, unknown> | undefined;

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
  buildChannelPermissionCellQuery: () => cellQueryOverride,
}));

mock.module("../telemetry/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: async () => 0,
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
      input_schema: {},
      execute: async () => fakeToolResult,
    };
  },
  getAllTools: () => [],
}));

/** Records every getAutoApproveThreshold call so tests can assert the cell
 * query is threaded into each read (including the background auto-approve). */
const thresholdReadLog: Array<{
  conversationId?: string;
  executionContext?: string;
  cellQuery?: Record<string, unknown>;
}> = [];

mock.module("../permissions/gateway-threshold-reader.js", () => ({
  getAutoApproveThreshold: async (
    conversationId?: string,
    executionContext?: string,
    cellQuery?: Record<string, unknown>,
  ) => {
    thresholdReadLog.push({ conversationId, executionContext, cellQuery });
    return thresholdOverride;
  },
  // Refresh failure ("null") keeps the original decision — these tests
  // exercise the cached-threshold paths only.
  refreshAutoApproveThreshold: async () => null,
  _clearGlobalCacheForTesting: () => {},
}));

// Stub the workflow run manager so the `manage_workflows` resume gate can read a
// target run's STORED capabilities without a real journal/DB. Tests set
// `fakeWorkflowRun` to control the stored manifest (or null for "not found").
let fakeWorkflowRun: {
  capabilities: unknown;
  conversationId: string | null;
} | null = null;
mock.module("../workflows/run-manager.js", () => ({
  getWorkflowRunManager: () => ({
    status: (_runId: string) => fakeWorkflowRun,
  }),
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
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
    thresholdOverride = "medium";
    cellQueryOverride = undefined;
    thresholdReadLog.length = 0;
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

  test("the non-interactive guardian background read consults the channel cell", async () => {
    // Regression: the background auto-approve re-read must carry the same
    // channel-permission cell query as check(). Without it, a Slack guardian
    // turn whose channel cell is Strict would be auto-approved off the looser
    // background global — silently bypassing the cell.
    riskOverride = RiskLevel.Medium;
    checkResultOverride = { decision: "prompt", reason: "Needs approval" };
    cellQueryOverride = {
      adapter: "slack",
      channelType: "dm",
      channelExternalId: "C123",
      contactType: "guardian",
    };

    const executor = new ToolExecutor(makePrompter());
    await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({ isInteractive: false, trustClass: "guardian" }),
    );

    const backgroundRead = thresholdReadLog.find(
      (r) => r.executionContext === "background",
    );
    expect(backgroundRead).toBeDefined();
    expect(backgroundRead?.cellQuery).toEqual(cellQueryOverride);
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
      makeContext({
        isInteractive: false,
        trustClass: "guardian",
        requireFreshApproval: true,
      }),
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
      makeContext({
        isInteractive: false,
        trustClass: "guardian",
        requireFreshApproval: true,
      }),
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
    thresholdOverride = "medium";
  });

  afterEach(() => {});

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
    thresholdOverride = "medium";
  });

  afterEach(() => {});

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
    thresholdOverride = "medium";
  });

  afterEach(() => {});

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

// ---------------------------------------------------------------------------
// Workflow launch consent: a run_workflow whose capability manifest grants
// side-effecting tools/host functions must prompt at LAUNCH (the manifest is
// model-declared and leaves execute granted tools directly, with no per-call
// check). A read-only run launches silently.
// ---------------------------------------------------------------------------

describe("requireFreshApproval: workflow capability grants", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    checkResultOverride = undefined;
    scopeOptionsOverride = undefined;
    riskOverride = "low";
    thresholdOverride = "medium";
    fakeWorkflowRun = null;
  });

  afterEach(() => {});

  function trackingPrompter(state: { prompted: boolean }): PermissionPrompter {
    return {
      prompt: async () => {
        state.prompted = true;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;
  }

  test("run_workflow granting side-effecting tools prompts at launch", async () => {
    // A grant of `bash` would normally auto-allow (mocked check() returns
    // allow); requireFreshApproval promotes it to an interactive prompt.
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    const result = await executor.execute(
      "run_workflow",
      { script: "export const meta={};", capabilities: { tools: ["bash"] } },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBe(true);
    expect(state.prompted).toBe(true);
    expect(result.isError).toBe(false);
  });

  test.each(["none", "low", "medium"] as const)(
    "run_workflow side-effecting launch prompts at the %s threshold (non-full-access posture)",
    async (threshold) => {
      checkResultOverride = { decision: "allow", reason: "allowed" };
      thresholdOverride = threshold;
      const state = { prompted: false };
      const executor = new ToolExecutor(trackingPrompter(state));
      const ctx = makeContext();

      const result = await executor.execute(
        "run_workflow",
        { script: "export const meta={};", capabilities: { tools: ["bash"] } },
        ctx,
      );

      expect(ctx.requireFreshApproval).toBe(true);
      expect(state.prompted).toBe(true);
      expect(result.isError).toBe(false);
    },
  );

  test("run_workflow side-effecting launch does NOT prompt at full access (high)", async () => {
    // Full-access posture auto-approves even high-risk tools, so the
    // requireFreshApproval promotion is skipped — the grant auto-allows.
    checkResultOverride = { decision: "allow", reason: "allowed" };
    thresholdOverride = "high";
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    const result = await executor.execute(
      "run_workflow",
      { script: "export const meta={};", capabilities: { tools: ["bash"] } },
      ctx,
    );

    // requireFreshApproval is still SET on the context (launch is
    // side-effecting); only the allow → prompt promotion is suppressed.
    expect(ctx.requireFreshApproval).toBe(true);
    expect(state.prompted).toBe(false);
    expect(result.isError).toBe(false);
  });

  test("a deny rule still blocks a side-effecting launch at full access (high)", async () => {
    // Full access skips the fresh-approval promotion but never overrides an
    // explicit deny — deny rules win regardless of posture.
    checkResultOverride = { decision: "deny", reason: "blocked by rule" };
    thresholdOverride = "high";
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    const result = await executor.execute(
      "run_workflow",
      { script: "export const meta={};", capabilities: { tools: ["bash"] } },
      ctx,
    );

    expect(state.prompted).toBe(false);
    expect(result.isError).toBe(true);
  });

  test("a deny rule still blocks a side-effecting launch at a normal threshold", async () => {
    checkResultOverride = { decision: "deny", reason: "blocked by rule" };
    thresholdOverride = "medium";
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    const result = await executor.execute(
      "run_workflow",
      { script: "export const meta={};", capabilities: { tools: ["bash"] } },
      ctx,
    );

    expect(state.prompted).toBe(false);
    expect(result.isError).toBe(true);
  });

  test("a read-only launch (no requireFreshApproval) is unaffected by a normal threshold", async () => {
    // No requireFreshApproval means the allow stands untouched at any posture.
    checkResultOverride = { decision: "allow", reason: "allowed" };
    thresholdOverride = "medium";
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    const result = await executor.execute(
      "run_workflow",
      { script: "export const meta={};", capabilities: {} },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBeUndefined();
    expect(state.prompted).toBe(false);
    expect(result.isError).toBe(false);
  });

  test("run_workflow granting host functions prompts at launch", async () => {
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    await executor.execute(
      "run_workflow",
      {
        script: "export const meta={};",
        capabilities: { hostFunctions: ["notify"] },
      },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBe(true);
    expect(state.prompted).toBe(true);
  });

  test("read-only run_workflow launches silently (no fresh approval, no prompt)", async () => {
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    const result = await executor.execute(
      "run_workflow",
      { script: "export const meta={};", capabilities: {} },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBeUndefined();
    expect(state.prompted).toBe(false);
    expect(result.isError).toBe(false);
  });

  test("workflow-mode schedule_create granting side-effecting tools prompts at creation", async () => {
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    const result = await executor.execute(
      "schedule_create",
      {
        name: "Nightly writeback",
        mode: "workflow",
        workflow_name: "nightly-report",
        capabilities: { tools: ["bash"] },
      },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBe(true);
    expect(state.prompted).toBe(true);
    expect(result.isError).toBe(false);
  });

  test("workflow-mode schedule_create granting host functions prompts at creation", async () => {
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    await executor.execute(
      "schedule_create",
      {
        name: "Nightly notify",
        mode: "workflow",
        workflow_name: "nightly-report",
        capabilities: { hostFunctions: ["notify"] },
      },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBe(true);
    expect(state.prompted).toBe(true);
  });

  test("workflow-mode schedule_create with a read-only manifest stays silent", async () => {
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    const result = await executor.execute(
      "schedule_create",
      {
        name: "Read-only schedule",
        mode: "workflow",
        workflow_name: "nightly-report",
        capabilities: {},
      },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBeUndefined();
    expect(state.prompted).toBe(false);
    expect(result.isError).toBe(false);
  });

  test("non-workflow schedule_create never gates even with a side-effecting capabilities blob", async () => {
    // The capabilities field is workflow-mode only; an execute-mode schedule
    // must not be promoted to a fresh approval by a stray capabilities object.
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    await executor.execute(
      "schedule_create",
      {
        name: "Execute schedule",
        mode: "execute",
        message: "do the thing",
        capabilities: { tools: ["bash"] },
      },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBeUndefined();
    expect(state.prompted).toBe(false);
  });

  test("manage_workflows resume of a side-effecting run requires fresh approval", async () => {
    // The target run's STORED manifest granted tools, so resuming it (which
    // restarts unfinished side-effecting leaves) must re-prompt.
    fakeWorkflowRun = {
      capabilities: { tools: ["bash"] },
      conversationId: "conversation-1",
    };
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    await executor.execute(
      "manage_workflows",
      { action: "resume", run_id: "wf-run-1" },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBe(true);
    expect(state.prompted).toBe(true);
  });

  test("manage_workflows resume of a read-only run stays silent", async () => {
    fakeWorkflowRun = { capabilities: {}, conversationId: "conversation-1" };
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    await executor.execute(
      "manage_workflows",
      { action: "resume", run_id: "wf-run-1" },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBeUndefined();
    expect(state.prompted).toBe(false);
  });

  test("manage_workflows non-resume actions never gate (status of a side-effecting run)", async () => {
    // Even though the run granted tools, status/abort/list_runs are pure
    // control/reads and must stay low-risk and silent.
    fakeWorkflowRun = {
      capabilities: { tools: ["bash"] },
      conversationId: "conversation-1",
    };
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    await executor.execute(
      "manage_workflows",
      { action: "status", run_id: "wf-run-1" },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBeUndefined();
    expect(state.prompted).toBe(false);
  });

  test("manage_workflows resume of an unknown run does not gate (run not found)", async () => {
    fakeWorkflowRun = null;
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext();

    await executor.execute(
      "manage_workflows",
      { action: "resume", run_id: "missing" },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBeUndefined();
    expect(state.prompted).toBe(false);
  });

  test("a non-owner resuming another conversation's side-effecting run does NOT gate (no prompt, no existence leak)", async () => {
    // The run is side-effecting but belongs to a different conversation. The
    // tool will hide it as not-found, so the gate must not prompt — otherwise it
    // leaks that the run exists and nags the guardian for a no-op resume.
    fakeWorkflowRun = {
      capabilities: { tools: ["bash"] },
      conversationId: "other-conversation",
    };
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext({
      trustClass: "trusted_contact",
      conversationId: "conversation-1",
    });

    await executor.execute(
      "manage_workflows",
      { action: "resume", run_id: "wf-run-1" },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBeUndefined();
    expect(state.prompted).toBe(false);
  });

  test("a non-owner resuming its OWN side-effecting run still gates", async () => {
    fakeWorkflowRun = {
      capabilities: { tools: ["bash"] },
      conversationId: "conversation-1",
    };
    checkResultOverride = { decision: "allow", reason: "allowed" };
    const state = { prompted: false };
    const executor = new ToolExecutor(trackingPrompter(state));
    const ctx = makeContext({
      trustClass: "trusted_contact",
      conversationId: "conversation-1",
    });

    await executor.execute(
      "manage_workflows",
      { action: "resume", run_id: "wf-run-1" },
      ctx,
    );

    expect(ctx.requireFreshApproval).toBe(true);
    expect(state.prompted).toBe(true);
  });
});
