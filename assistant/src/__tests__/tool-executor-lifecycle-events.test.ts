import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ToolExecutionResult } from "../tools/types.js";
import type { UsageAttributionSnapshot } from "../usage/attribution.js";

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
  permissions: {
    mode: "workspace" as const,
  },
};

let checkerDecision: "allow" | "prompt" | "deny" = "allow";
let checkerReason = "allowed";
let checkerRisk = "low";
let promptDecision: "allow" | "deny" = "allow";
let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };
let toolThrow: Error | null = null;

// ── audit-terminal captures ───────────────────────────────
// The executor and its permission/approval collaborators no longer emit
// lifecycle events through a context callback; they call direct terminal
// functions in `../telemetry/tool-audit.js`. Mock those terminals here
// (declared before importing the ToolExecutor so the mock intercepts the
// executor's static import) and capture each call into an array. Every test
// below asserts against these captures instead of an emitted-event stream.

interface ExecutedCapture {
  conversationId: string;
  toolName: string;
  input: Record<string, unknown>;
  resultContent: string;
  resultBytes: number;
  decision: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  attribution: UsageAttributionSnapshot | null;
  wasPrompted: boolean;
}

interface ErrorCapture {
  conversationId: string;
  requestId?: string;
  toolName: string;
  input: Record<string, unknown>;
  errorMessage: string;
  isExpected: boolean;
  errorName?: string;
  errorStack?: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  attribution: UsageAttributionSnapshot | null;
}

interface DeniedCapture {
  conversationId: string;
  toolName: string;
  input: Record<string, unknown>;
  reason: string;
  riskLevel: string;
  matchedTrustRuleId?: string;
  durationMs: number;
  wasPrompted: boolean;
}

const executedCaptures: ExecutedCapture[] = [];
const errorCaptures: ErrorCapture[] = [];
const deniedCaptures: DeniedCapture[] = [];
const promptedCaptures: string[] = [];

mock.module("../telemetry/tool-audit.js", () => ({
  recordToolExecuted: (entry: ExecutedCapture) => {
    executedCaptures.push(entry);
  },
  recordToolError: (entry: ErrorCapture) => {
    errorCaptures.push(entry);
  },
  recordToolDenied: (entry: DeniedCapture) => {
    deniedCaptures.push(entry);
  },
  recordToolPermissionPrompted: (toolName: string) => {
    promptedCaptures.push(toolName);
  },
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

// Analytics consent is granted so any consent-gated telemetry path the audit
// terminals consult sees the opted-in state.
mock.module("../platform/consent-cache.js", () => ({
  getCachedShareAnalytics: () => true,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

mock.module("../permissions/checker.js", () => ({
  isDynamicSkillLoadInvocation: () => false,
  classifyRisk: async () => ({ level: checkerRisk }),
  check: async () => ({ decision: checkerDecision, reason: checkerReason }),
  generateAllowlistOptions: () => [
    { label: "exact", description: "exact", pattern: "exact" },
  ],
  generateScopeOptions: () => [{ label: "/tmp", scope: "/tmp" }],
  getCachedAssessment: () => undefined,
}));

mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  createConversation: (title: string) => ({ id: "conversation-1", title }),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

// Mock every export so downstream test files that dynamically import modules
// with a static `from "../telemetry/tool-usage-store.js"` still see all symbols.
mock.module("../telemetry/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: async () => 0,
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => {
    if (name === "unknown_tool") {
      return undefined;
    }
    // Skill tools carry executionTarget from their manifest. Ownership lives
    // on the registry (mocked below via getToolOwner reading the override's
    // owner field), so it doesn't appear on the Tool object itself.
    if (name === "skill_host_tool") {
      return {
        name,
        description: "skill host tool",
        category: "skill",
        defaultRiskLevel: "low",
        owner: { kind: "skill", id: "test-skill" },
        executionTarget: "host" as const,
        input_schema: {},
        execute: async () => {
          if (toolThrow) {
            throw toolThrow;
          }
          return fakeToolResult;
        },
      };
    }
    if (name === "skill_sandbox_tool") {
      return {
        name,
        description: "skill sandbox tool",
        category: "skill",
        defaultRiskLevel: "low",
        owner: { kind: "skill", id: "test-skill" },
        executionTarget: "sandbox" as const,
        input_schema: {},
        execute: async () => {
          if (toolThrow) {
            throw toolThrow;
          }
          return fakeToolResult;
        },
      };
    }
    // Skill tool whose name starts with host_ but manifest says sandbox —
    // verifies manifest takes priority over prefix heuristics.
    if (name === "host_skill_sandboxed") {
      return {
        name,
        description: "skill tool with host_ prefix but sandbox target",
        category: "skill",
        defaultRiskLevel: "low",
        owner: { kind: "skill", id: "test-skill" },
        executionTarget: "sandbox" as const,
        input_schema: {},
        execute: async () => {
          if (toolThrow) {
            throw toolThrow;
          }
          return fakeToolResult;
        },
      };
    }
    // Mirror what the real loader stamps onto a tool at registration time
    // (every registered Tool has `executionTarget` set). Mirror the
    // prefix heuristic here so the tests that exercise built-in tools
    // (`bash`, `host_bash`, `file_read`) still observe production-shaped
    // executionTarget values.
    const executionTarget =
      name.startsWith("host_") || name.startsWith("computer_use_")
        ? ("host" as const)
        : ("sandbox" as const);
    return {
      name,
      description: "test tool",
      category: "test",
      defaultRiskLevel: "low",
      executionTarget,
      input_schema: {},
      execute: async () => {
        if (toolThrow) {
          throw toolThrow;
        }
        return fakeToolResult;
      },
    };
  },
  // Ownership lives on the registry post-refactor. Mirror that by surfacing
  // the optional `owner`-shaped field set inline on the override-produced
  // tool (see the skill_* branches above).
  getToolOwner: (name: string) => {
    if (
      name === "skill_host_tool" ||
      name === "skill_sandbox_tool" ||
      name === "host_skill_sandboxed"
    ) {
      return { kind: "skill" as const, id: "test-skill" };
    }
    return undefined;
  },
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

import { PermissionPrompter } from "../permissions/prompter.js";
import { ToolExecutor } from "../tools/executor.js";
import { ToolProfiler } from "../tools/tool-profiler.js";
import { ToolError } from "../util/errors.js";

function makeContext(extra: Record<string, unknown> = {}) {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass: "guardian" as const,
    ...extra,
  };
}

function makePrompter(
  promptImpl?: () => Promise<{
    decision: "allow" | "deny";
    decisionContext?: string;
  }>,
) {
  return {
    prompt: promptImpl ?? (async () => ({ decision: promptDecision })),
    resolveConfirmation: () => {},
    updateSender: () => {},
    dispose: () => {},
  } as unknown as PermissionPrompter;
}

describe("ToolExecutor audit terminals", () => {
  beforeEach(() => {
    checkerDecision = "allow";
    checkerReason = "allowed";
    checkerRisk = "low";
    promptDecision = "allow";
    fakeToolResult = { content: "ok", isError: false };
    toolThrow = null;
    executedCaptures.length = 0;
    errorCaptures.length = 0;
    deniedCaptures.length = 0;
    promptedCaptures.length = 0;
  });

  test("records executed terminal for allowed execution", async () => {
    const profiler = new ToolProfiler();
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ profiler }),
    );

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(executedCaptures).toHaveLength(1);
    expect(errorCaptures).toHaveLength(0);
    const executed = executedCaptures[0];
    expect(executed.toolName).toBe("file_read");
    expect(executed.decision).toBe("allow");
    expect(executed.riskLevel).toBe("low");
    expect(executed.resultContent).toBe("ok");
    expect(executed.resultBytes).toBe(Buffer.byteLength("ok", "utf8"));
    expect(executed.wasPrompted).toBe(false);
    expect(executed.durationMs).toBeGreaterThanOrEqual(0);

    // The executor records the completion on the profiler at the same terminal.
    const summary = profiler.getSummary();
    expect(summary.tools.file_read?.count).toBe(1);
    expect(summary.tools.file_read?.errors).toBe(0);
  });

  test("records denied terminal when user denies prompt", async () => {
    checkerDecision = "prompt";
    checkerReason = "medium risk: requires approval";
    checkerRisk = "medium";
    promptDecision = "deny";

    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "bash",
      { command: "ls -la" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied");

    // A prompt was surfaced, then the user's denial recorded a denied terminal.
    expect(promptedCaptures).toEqual(["bash"]);
    expect(executedCaptures).toHaveLength(0);
    expect(deniedCaptures).toHaveLength(1);
    const denied = deniedCaptures[0];
    expect(denied.toolName).toBe("bash");
    expect(denied.riskLevel).toBe("medium");
    expect(denied.reason).toBe("Permission denied by user");
    expect(denied.wasPrompted).toBe(true);
  });

  test("uses contextual deny messaging when provided by prompter", async () => {
    checkerDecision = "prompt";
    checkerReason = "guardrail prompt";
    checkerRisk = "high";

    const executor = new ToolExecutor(
      makePrompter(async () => ({
        decision: "deny",
        decisionContext:
          "Permission denied: this action requires guardian setup before retrying. Explain this and provide setup steps.",
      })),
    );

    const result = await executor.execute(
      "bash",
      { command: "echo hi" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires guardian setup");
    expect(result.content).not.toContain("Permission denied by user");

    expect(deniedCaptures).toHaveLength(1);
    expect(deniedCaptures[0].reason).toBe(
      "Permission denied (bash): contextual policy",
    );
    expect(deniedCaptures[0].wasPrompted).toBe(true);
  });

  // executionTarget is no longer carried on any audit-terminal payload, so
  // routing can only be observed as "the host tool ran to completion".
  test("records executed terminal for host tools", async () => {
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "host_file_read",
      { path: "/tmp/file.txt" },
      makeContext(),
    );

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].toolName).toBe("host_file_read");
  });

  test("records denied terminal when blocked by deny rule", async () => {
    checkerDecision = "deny";
    checkerReason = "Blocked by deny rule: rm *";

    const executor = new ToolExecutor(
      makePrompter(async () => {
        throw new Error("prompter should not be called");
      }),
    );

    const result = await executor.execute(
      "bash",
      { command: "rm -rf /tmp" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result).toMatchObject({
      content: "Blocked by deny rule: rm *",
      isError: true,
    });
    // A deterministic deny rule blocks without prompting.
    expect(promptedCaptures).toHaveLength(0);
    expect(deniedCaptures).toHaveLength(1);
    expect(deniedCaptures[0].reason).toBe("Blocked by deny rule: rm *");
    expect(deniedCaptures[0].wasPrompted).toBe(false);
  });

  test("records error terminal when tool execution throws", async () => {
    toolThrow = new Error("boom");

    const profiler = new ToolProfiler();
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "file_read",
      {},
      makeContext({ profiler }),
    );

    expect(result.content).toContain("boom");
    expect(result.isError).toBe(true);
    expect(executedCaptures).toHaveLength(0);
    expect(errorCaptures).toHaveLength(1);
    const error = errorCaptures[0];
    expect(error.errorMessage).toBe("boom");
    expect(error.isExpected).toBe(false);
    expect(error.errorName).toBe("Error");
    expect(error.errorStack).toContain("Error: boom");

    const summary = profiler.getSummary();
    expect(summary.tools.file_read?.count).toBe(1);
    expect(summary.tools.file_read?.errors).toBe(1);
  });

  test("marks ToolError failures as expected", async () => {
    toolThrow = new ToolError("tool failed", "file_read");

    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute("file_read", {}, makeContext());

    expect(result).toEqual({ content: "tool failed", isError: true });
    expect(errorCaptures).toHaveLength(1);
    expect(errorCaptures[0].isExpected).toBe(true);
    expect(errorCaptures[0].errorName).toBe("ToolError");
  });

  test("records error terminal for unknown tools", async () => {
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "unknown_tool",
      { test: true },
      makeContext(),
    );

    expect(result).toEqual({
      content: expect.stringContaining("Unknown tool: unknown_tool"),
      isError: true,
    });
    expect(errorCaptures).toHaveLength(1);
    expect(errorCaptures[0].errorMessage).toContain(
      "Unknown tool: unknown_tool",
    );
    expect(errorCaptures[0].isExpected).toBe(true);
  });

  // The following tests previously verified the resolved `executionTarget` on
  // the emitted lifecycle event. That field is gone from the audit terminals,
  // so they now verify the routed tool still runs to an executed terminal.
  test("bash tool executes to an executed terminal", async () => {
    const executor = new ToolExecutor(makePrompter());

    await executor.execute("bash", { command: "echo hello" }, makeContext());

    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].toolName).toBe("bash");
  });

  test("host_bash tool executes to an executed terminal", async () => {
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "host_bash",
      { command: "echo hello" },
      makeContext(),
    );

    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].toolName).toBe("host_bash");
  });

  test("executes a skill tool whose context.executionTarget is host", async () => {
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "skill_host_tool",
      { query: "test" },
      makeContext({ executionTarget: "host" }),
    );

    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].toolName).toBe("skill_host_tool");
  });

  test("executes a host_-named tool whose context.executionTarget is sandbox", async () => {
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "host_skill_sandboxed",
      { query: "test" },
      makeContext({ executionTarget: "sandbox" }),
    );

    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].toolName).toBe("host_skill_sandboxed");
  });

  // ── attribution forwarding tests ──────────────────────────

  // Uses a non-main call site (voice turn) so these tests also prove the
  // executor forwards the snapshot verbatim — non-main turns must not be
  // rewritten to the main agent's attribution.
  const testAttribution: UsageAttributionSnapshot = {
    callSite: "callAgent",
    activeProfile: "balanced",
    overrideProfile: null,
    callSiteProfile: "voice-profile",
    appliedProfile: "voice-profile",
    profileSource: "call_site",
    resolvedProvider: "anthropic",
    resolvedModel: "test-model",
    resolvedMixArm: null,
  };

  test("forwards context.attribution into the executed terminal", async () => {
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ attribution: testAttribution }),
    );

    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].attribution).toEqual(testAttribution);
  });

  test("forwards context.attribution into the error terminal", async () => {
    toolThrow = new Error("boom");

    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "file_read",
      {},
      makeContext({ attribution: testAttribution }),
    );

    expect(errorCaptures).toHaveLength(1);
    expect(errorCaptures[0].attribution).toEqual(testAttribution);
  });

  test("missing context.attribution yields null on the executed terminal without throwing", async () => {
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].attribution).toBeNull();
  });

  test("missing context.attribution yields null on the error terminal without throwing", async () => {
    toolThrow = new Error("boom");

    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute("file_read", {}, makeContext());

    expect(result.isError).toBe(true);
    expect(errorCaptures).toHaveLength(1);
    expect(errorCaptures[0].attribution).toBeNull();
  });

  test("stamps attribution on pre-execution gate error terminals (unknown tool)", async () => {
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "unknown_tool",
      { test: true },
      makeContext({ attribution: testAttribution }),
    );

    expect(result.isError).toBe(true);
    expect(errorCaptures).toHaveLength(1);
    expect(errorCaptures[0].errorMessage).toContain(
      "Unknown tool: unknown_tool",
    );
    expect(errorCaptures[0].attribution).toEqual(testAttribution);
  });

  test("missing attribution yields null on pre-execution gate error terminals", async () => {
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "unknown_tool",
      { test: true },
      makeContext(),
    );

    expect(result.isError).toBe(true);
    expect(errorCaptures).toHaveLength(1);
    expect(errorCaptures[0].attribution).toBeNull();
  });

  test("stamps attribution on the aborted pre-execution gate error terminal", async () => {
    const executor = new ToolExecutor(makePrompter());
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({
        attribution: testAttribution,
        signal: controller.signal,
      }),
    );

    expect(result).toEqual({ content: "Cancelled", isError: true });
    expect(errorCaptures).toHaveLength(1);
    expect(errorCaptures[0].errorMessage).toBe("Cancelled");
    expect(errorCaptures[0].attribution).toEqual(testAttribution);
  });

  // ── raw payload forwarding tests ──────────────────────────
  // The executor hands the RAW (pre-redaction, pre-sanitization) input and the
  // RAW result byte size to the audit terminal; redaction and arg sizing happen
  // downstream inside tool-audit. These assert the executor does not shrink or
  // pre-redact the payload before the terminal.

  test("forwards the raw input to the executed terminal even when it holds redactable fields", async () => {
    const executor = new ToolExecutor(makePrompter());

    const rawInput = { path: "README.md", token: "t-1" };

    await executor.execute("file_read", rawInput, makeContext());

    expect(executedCaptures).toHaveLength(1);
    // The terminal receives the raw input verbatim; redaction is tool-audit's job.
    expect(executedCaptures[0].input).toEqual(rawInput);
  });

  test("forwards the raw input to the error terminal", async () => {
    toolThrow = new Error("boom");

    const executor = new ToolExecutor(makePrompter());

    const rawInput = { path: "README.md", api_key: "k-1" };

    await executor.execute("file_read", rawInput, makeContext());

    expect(errorCaptures).toHaveLength(1);
    expect(errorCaptures[0].input).toEqual(rawInput);
  });

  test("stamps resultBytes from the raw content before sensitive-output sanitization", async () => {
    // Directive stripping + placeholder substitution shrink the content the
    // executed terminal carries; the stamped size must reflect the raw output.
    const rawContent =
      'Your invite: <vellum-sensitive-output kind="invite_code" value="SECRET-CODE-123" /> use SECRET-CODE-123';
    fakeToolResult = { content: rawContent, isError: false };

    const executor = new ToolExecutor(makePrompter());

    await executor.execute("file_read", { path: "a" }, makeContext());

    expect(executedCaptures).toHaveLength(1);
    const executed = executedCaptures[0];
    // The terminal carries the sanitized content...
    expect(executed.resultContent).not.toContain("SECRET-CODE-123");
    // ...but the stamped size is the raw pre-sanitization byte length.
    expect(executed.resultBytes).toBe(Buffer.byteLength(rawContent, "utf8"));
    expect(executed.resultBytes).not.toBe(
      Buffer.byteLength(executed.resultContent, "utf8"),
    );
  });

  test("stamps resultBytes for non-sensitive results too (raw equals emitted content)", async () => {
    const executor = new ToolExecutor(makePrompter());

    await executor.execute("file_read", { path: "a" }, makeContext());

    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].resultContent).toBe("ok");
    expect(executedCaptures[0].resultBytes).toBe(
      Buffer.byteLength("ok", "utf8"),
    );
  });

  test("executes a skill tool whose manifest declares a sandbox target", async () => {
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "skill_sandbox_tool",
      { query: "test" },
      makeContext(),
    );

    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].toolName).toBe("skill_sandbox_tool");
  });

  // The removed lifecycle machinery had an async `onToolLifecycleEvent`
  // callback the executor deliberately did not await; the audit terminals are
  // now synchronous direct calls, so there is no async callback left to block
  // on. The previous "does not block on unresolved lifecycle callbacks" test
  // covered a contract that no longer exists and has been removed.

  // ── forcePromptSideEffects terminal tests ─────────────────

  test("prompts for bash under forcePromptSideEffects (side-effect tool)", async () => {
    checkerDecision = "allow";
    checkerReason = "Matched trust rule";
    checkerRisk = "low";
    promptDecision = "allow";

    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "bash",
      { command: "npm install" },
      makeContext({ forcePromptSideEffects: true }),
    );

    // forcePromptSideEffects promotes the auto-allow to an interactive prompt.
    expect(promptedCaptures).toEqual(["bash"]);
    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].toolName).toBe("bash");
  });

  test("no prompt for read-only tool even with forcePromptSideEffects", async () => {
    checkerDecision = "allow";
    checkerReason = "allowed";
    checkerRisk = "low";

    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "file_read",
      { path: "/tmp/project/README.md" },
      makeContext({ forcePromptSideEffects: true }),
    );

    // file_read is not a side-effect tool, so no prompt terminal should fire.
    expect(promptedCaptures).toHaveLength(0);
    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].toolName).toBe("file_read");
  });

  test("file_edit to guardian persona prompts under forcePromptSideEffects", async () => {
    // Security invariant: forced side-effect prompting must prompt even when a
    // trust rule would auto-allow.
    checkerDecision = "allow";
    checkerReason = "Matched trust rule: file_edit:*/users/*.md";
    checkerRisk = "low";
    promptDecision = "allow";

    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "file_edit",
      {
        path: "/Users/alice/.vellum/workspace/users/alice.md",
        old_string: "old",
        new_string: "new",
      },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(promptedCaptures).toEqual(["file_edit"]);
    expect(executedCaptures).toHaveLength(1);
    expect(executedCaptures[0].toolName).toBe("file_edit");
  });
});
