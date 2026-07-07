import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ToolExecutionResult,
  ToolLifecycleEvent,
} from "../tools/types.js";
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

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  getNestedValue: () => undefined,
  setNestedValue: () => {},
}));

// Analytics consent is granted so the audit listener populates the telemetry
// columns; the end-to-end listener tests below assert the opted-in sizing.
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
import { ToolError } from "../util/errors.js";

function makeContext(
  events: ToolLifecycleEvent[],
  extra: Record<string, unknown> = {},
) {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass: "guardian" as const,
    onToolLifecycleEvent: (event: ToolLifecycleEvent) => {
      events.push(event);
    },
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

describe("ToolExecutor lifecycle events", () => {
  beforeEach(() => {
    checkerDecision = "allow";
    checkerReason = "allowed";
    checkerRisk = "low";
    promptDecision = "allow";
    fakeToolResult = { content: "ok", isError: false };
    toolThrow = null;
  });

  test("emits start then executed for allowed execution", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(events),
    );

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(events.map((event) => event.type)).toEqual(["start", "executed"]);
    expect(events[0]).toMatchObject({
      type: "start",
      toolName: "file_read",
      executionTarget: "sandbox",
      conversationId: "conversation-1",
      workingDir: "/tmp/project",
    });
    const executed = events[1];
    if (executed.type !== "executed") {
      throw new Error("Expected executed event");
    }
    expect(executed.executionTarget).toBe("sandbox");
    expect(executed.riskLevel).toBe("low");
    expect(executed.result).toMatchObject({ content: "ok", isError: false });
    expect(executed.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("emits permission_prompt then permission_denied when user denies prompt", async () => {
    checkerDecision = "prompt";
    checkerReason = "medium risk: requires approval";
    checkerRisk = "medium";
    promptDecision = "deny";

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "bash",
      { command: "ls -la" },
      makeContext(events, { forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied");
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "permission_prompt",
      "permission_denied",
    ]);

    const promptEvent = events[1];
    if (promptEvent.type !== "permission_prompt") {
      throw new Error("Expected permission_prompt event");
    }
    expect(promptEvent.executionTarget).toBe("sandbox");
    expect(promptEvent.riskLevel).toBe("medium");
    expect(promptEvent.reason).toBe("medium risk: requires approval");
    expect(promptEvent.allowlistOptions).toEqual([
      { label: "exact", description: "exact", pattern: "exact" },
    ]);
    expect(promptEvent.scopeOptions).toEqual([
      { label: "/tmp", scope: "/tmp" },
    ]);

    const deniedEvent = events[2];
    if (deniedEvent.type !== "permission_denied") {
      throw new Error("Expected permission_denied event");
    }
    expect(deniedEvent.executionTarget).toBe("sandbox");
    expect(deniedEvent.decision).toBe("deny");
    expect(deniedEvent.reason).toBe("Permission denied by user");
  });

  test("uses contextual deny messaging when provided by prompter", async () => {
    checkerDecision = "prompt";
    checkerReason = "guardrail prompt";
    checkerRisk = "high";

    const events: ToolLifecycleEvent[] = [];
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
      makeContext(events, { forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("requires guardian setup");
    expect(result.content).not.toContain("Permission denied by user");

    const deniedEvent = events.find(
      (event) => event.type === "permission_denied",
    );
    if (!deniedEvent || deniedEvent.type !== "permission_denied") {
      throw new Error("Expected permission_denied event");
    }
    expect(deniedEvent.reason).toBe(
      "Permission denied (bash): contextual policy",
    );
  });

  test("emits host executionTarget for host tools", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "host_file_read",
      { path: "/tmp/file.txt" },
      makeContext(events),
    );

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(events.map((event) => event.type)).toEqual(["start", "executed"]);
    const startEvent = events[0];
    if (startEvent.type !== "start") {
      throw new Error("Expected start event");
    }
    expect(startEvent.executionTarget).toBe("host");
    const executed = events[1];
    if (executed.type !== "executed") {
      throw new Error("Expected executed event");
    }
    expect(executed.executionTarget).toBe("host");
  });

  test("emits permission_denied when blocked by deny rule", async () => {
    checkerDecision = "deny";
    checkerReason = "Blocked by deny rule: rm *";

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(
      makePrompter(async () => {
        throw new Error("prompter should not be called");
      }),
    );

    const result = await executor.execute(
      "bash",
      { command: "rm -rf /tmp" },
      makeContext(events, { forcePromptSideEffects: true }),
    );

    expect(result).toMatchObject({
      content: "Blocked by deny rule: rm *",
      isError: true,
    });
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "permission_denied",
    ]);
    const deniedEvent = events[1];
    if (deniedEvent.type !== "permission_denied") {
      throw new Error("Expected permission_denied event");
    }
    expect(deniedEvent.reason).toBe("Blocked by deny rule: rm *");
  });

  test("emits error when tool execution throws", async () => {
    toolThrow = new Error("boom");

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute("file_read", {}, makeContext(events));

    expect(result.content).toContain("boom");
    expect(result.isError).toBe(true);
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    const errorEvent = events[1];
    if (errorEvent.type !== "error") {
      throw new Error("Expected error event");
    }
    expect(errorEvent.errorMessage).toBe("boom");
    expect(errorEvent.isExpected).toBe(false);
    expect(errorEvent.errorName).toBe("Error");
    expect(errorEvent.errorStack).toContain("Error: boom");
  });

  test("marks ToolError failures as expected", async () => {
    toolThrow = new ToolError("tool failed", "file_read");

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute("file_read", {}, makeContext(events));

    expect(result).toEqual({ content: "tool failed", isError: true });
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    const errorEvent = events[1];
    if (errorEvent.type !== "error") {
      throw new Error("Expected error event");
    }
    expect(errorEvent.isExpected).toBe(true);
    expect(errorEvent.errorName).toBe("ToolError");
  });

  test("emits start and error for unknown tools", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "unknown_tool",
      { test: true },
      makeContext(events),
    );

    expect(result).toEqual({
      content: expect.stringContaining("Unknown tool: unknown_tool"),
      isError: true,
    });
    expect(events.map((event) => event.type)).toEqual(["start", "error"]);
    const errorEvent = events[1];
    if (errorEvent.type !== "error") {
      throw new Error("Expected error event");
    }
    expect(errorEvent.errorMessage).toContain("Unknown tool: unknown_tool");
    expect(errorEvent.decision).toBe("error");
    expect(errorEvent.isExpected).toBe(true);
  });

  test("bash tool resolves to sandbox executionTarget", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext(events),
    );

    const startEvent = events[0];
    if (startEvent.type !== "start") {
      throw new Error("Expected start event");
    }
    expect(startEvent.executionTarget).toBe("sandbox");
    const executedEvent = events.find(
      (e) => e.type === "executed" || e.type === "error",
    );
    expect(executedEvent?.executionTarget).toBe("sandbox");
  });

  test("host_bash tool resolves to host executionTarget", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "host_bash",
      { command: "echo hello" },
      makeContext(events),
    );

    const startEvent = events[0];
    if (startEvent.type !== "start") {
      throw new Error("Expected start event");
    }
    expect(startEvent.executionTarget).toBe("host");
    const executedEvent = events.find(
      (e) => e.type === "executed" || e.type === "error",
    );
    expect(executedEvent?.executionTarget).toBe("host");
  });

  test("forwards a host context.executionTarget into lifecycle events", async () => {
    // The resolver stamps executionTarget from the tool presented to the model
    // (e.g. a skill tool whose manifest declares "host"); the executor routes
    // and emits by that context value, not a registry re-lookup.
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "skill_host_tool",
      { query: "test" },
      makeContext(events, { executionTarget: "host" }),
    );

    expect(events.map((event) => event.type)).toEqual(["start", "executed"]);
    const startEvent = events[0];
    if (startEvent.type !== "start") {
      throw new Error("Expected start event");
    }
    expect(startEvent.executionTarget).toBe("host");
    const executed = events[1];
    if (executed.type !== "executed") {
      throw new Error("Expected executed event");
    }
    expect(executed.executionTarget).toBe("host");
  });

  test("forwards a sandbox context.executionTarget even for a host_ name", async () => {
    // A tool whose manifest declares "sandbox" despite a host_ prefix: the
    // resolver captures "sandbox" (resolveExecutionTarget honors the manifest),
    // and the executor forwards it verbatim rather than re-deriving from name.
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "host_skill_sandboxed",
      { query: "test" },
      makeContext(events, { executionTarget: "sandbox" }),
    );

    expect(events.map((event) => event.type)).toEqual(["start", "executed"]);
    const startEvent = events[0];
    if (startEvent.type !== "start") {
      throw new Error("Expected start event");
    }
    expect(startEvent.executionTarget).toBe("sandbox");
    const executed = events[1];
    if (executed.type !== "executed") {
      throw new Error("Expected executed event");
    }
    expect(executed.executionTarget).toBe("sandbox");
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

  test("forwards context.attribution into the executed lifecycle event", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(events, { attribution: testAttribution }),
    );

    const executed = events.find((event) => event.type === "executed");
    if (executed?.type !== "executed") {
      throw new Error("Expected executed event");
    }
    expect(executed.attribution).toEqual(testAttribution);
  });

  test("forwards context.attribution into the error lifecycle event", async () => {
    toolThrow = new Error("boom");

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "file_read",
      {},
      makeContext(events, { attribution: testAttribution }),
    );

    const errorEvent = events.find((event) => event.type === "error");
    if (errorEvent?.type !== "error") {
      throw new Error("Expected error event");
    }
    expect(errorEvent.attribution).toEqual(testAttribution);
  });

  test("missing context.attribution yields null on the executed event without throwing", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(events),
    );

    expect(result).toMatchObject({ content: "ok", isError: false });
    const executed = events.find((event) => event.type === "executed");
    if (executed?.type !== "executed") {
      throw new Error("Expected executed event");
    }
    expect(executed.attribution).toBeNull();
  });

  test("missing context.attribution yields null on the error event without throwing", async () => {
    toolThrow = new Error("boom");

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute("file_read", {}, makeContext(events));

    expect(result.isError).toBe(true);
    const errorEvent = events.find((event) => event.type === "error");
    if (errorEvent?.type !== "error") {
      throw new Error("Expected error event");
    }
    expect(errorEvent.attribution).toBeNull();
  });

  test("stamps attribution on pre-execution gate error events (unknown tool)", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "unknown_tool",
      { test: true },
      makeContext(events, { attribution: testAttribution }),
    );

    expect(result.isError).toBe(true);
    const errorEvent = events.find((event) => event.type === "error");
    if (errorEvent?.type !== "error") {
      throw new Error("Expected error event");
    }
    expect(errorEvent.errorMessage).toContain("Unknown tool: unknown_tool");
    expect(errorEvent.attribution).toEqual(testAttribution);
  });

  test("missing attribution yields null on pre-execution gate error events", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "unknown_tool",
      { test: true },
      makeContext(events),
    );

    expect(result.isError).toBe(true);
    const errorEvent = events.find((event) => event.type === "error");
    if (errorEvent?.type !== "error") {
      throw new Error("Expected error event");
    }
    expect(errorEvent.attribution).toBeNull();
  });

  test("stamps attribution on the aborted pre-execution gate error event", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());
    const controller = new AbortController();
    controller.abort();

    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(events, {
        attribution: testAttribution,
        signal: controller.signal,
      }),
    );

    expect(result).toEqual({ content: "Cancelled", isError: true });
    const errorEvent = events.find((event) => event.type === "error");
    if (errorEvent?.type !== "error") {
      throw new Error("Expected error event");
    }
    expect(errorEvent.errorMessage).toBe("Cancelled");
    expect(errorEvent.attribution).toEqual(testAttribution);
  });

  // ── raw input byte sizing tests ───────────────────────────

  test("stamps inputBytes from the raw input even when sanitization redacts fields", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const rawInput = { path: "README.md", token: "t-1" };
    const rawSize = Buffer.byteLength(JSON.stringify(rawInput), "utf8");

    await executor.execute("file_read", rawInput, makeContext(events));

    const executed = events.find((event) => event.type === "executed");
    if (executed?.type !== "executed") {
      throw new Error("Expected executed event");
    }
    // The event input is sanitized, but the size reflects the raw payload.
    expect(executed.input.token).toBe("<redacted />");
    expect(executed.inputBytes).toBe(rawSize);
    expect(executed.inputBytes).not.toBe(
      Buffer.byteLength(JSON.stringify(executed.input), "utf8"),
    );
  });

  test("stamps inputBytes from the raw input on error events", async () => {
    toolThrow = new Error("boom");

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const rawInput = { path: "README.md", api_key: "k-1" };

    await executor.execute("file_read", rawInput, makeContext(events));

    const errorEvent = events.find((event) => event.type === "error");
    if (errorEvent?.type !== "error") {
      throw new Error("Expected error event");
    }
    expect(errorEvent.input.api_key).toBe("<redacted />");
    expect(errorEvent.inputBytes).toBe(
      Buffer.byteLength(JSON.stringify(rawInput), "utf8"),
    );
  });

  test("stamps resultBytes from the raw content before sensitive-output sanitization", async () => {
    // Directive stripping + placeholder substitution shrink the content the
    // lifecycle event carries; the stamped size must reflect the raw output.
    const rawContent =
      'Your invite: <vellum-sensitive-output kind="invite_code" value="SECRET-CODE-123" /> use SECRET-CODE-123';
    fakeToolResult = { content: rawContent, isError: false };

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute("file_read", { path: "a" }, makeContext(events));

    const executed = events.find((event) => event.type === "executed");
    if (executed?.type !== "executed") {
      throw new Error("Expected executed event");
    }
    // The event carries the sanitized content...
    expect(executed.result.content).not.toContain("SECRET-CODE-123");
    // ...but the stamped size is the raw pre-sanitization byte length.
    expect(executed.resultBytes).toBe(Buffer.byteLength(rawContent, "utf8"));
    expect(executed.resultBytes).not.toBe(
      Buffer.byteLength(executed.result.content, "utf8"),
    );
  });

  test("stamps resultBytes for non-sensitive results too (raw equals emitted content)", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute("file_read", { path: "a" }, makeContext(events));

    const executed = events.find((event) => event.type === "executed");
    if (executed?.type !== "executed") {
      throw new Error("Expected executed event");
    }
    expect(executed.result.content).toBe("ok");
    expect(executed.resultBytes).toBe(Buffer.byteLength("ok", "utf8"));
  });

  test("audit listener records result_bytes from the raw pre-sanitization output", async () => {
    const { createToolAuditListener } =
      await import("../events/tool-audit-listener.js");
    const records: Array<{ resultBytes?: number | null; result: string }> = [];
    const executor = new ToolExecutor(makePrompter());

    const rawContent =
      'Code: <vellum-sensitive-output kind="invite_code" value="SECRET-CODE-456" />SECRET-CODE-456';
    fakeToolResult = { content: rawContent, isError: false };

    await executor.execute(
      "file_read",
      { path: "a" },
      {
        workingDir: "/tmp/project",
        conversationId: "conversation-1",
        trustClass: "guardian" as const,
        onToolLifecycleEvent: createToolAuditListener((record) =>
          records.push(record),
        ),
      },
    );

    expect(records).toHaveLength(1);
    expect(records[0].resultBytes).toBe(Buffer.byteLength(rawContent, "utf8"));
    // The stored result column is still the sanitized payload.
    expect(records[0].result).not.toContain("SECRET-CODE-456");
  });

  test("audit listener records arg_bytes equal to the raw serialized input size", async () => {
    // End-to-end: executor sanitization must not shrink the recorded
    // arg_bytes — the audit row sizes the raw pre-redaction input.
    const { createToolAuditListener } =
      await import("../events/tool-audit-listener.js");
    const records: Array<{ argBytes?: number | null; input: string }> = [];
    const executor = new ToolExecutor(makePrompter());

    const rawInput = { path: "README.md", token: "t-1" };

    await executor.execute("file_read", rawInput, {
      workingDir: "/tmp/project",
      conversationId: "conversation-1",
      trustClass: "guardian" as const,
      onToolLifecycleEvent: createToolAuditListener((record) =>
        records.push(record),
      ),
    });

    expect(records).toHaveLength(1);
    expect(records[0].argBytes).toBe(
      Buffer.byteLength(JSON.stringify(rawInput), "utf8"),
    );
    // The stored input column is still the redacted payload.
    expect(records[0].input).not.toContain("t-1");
  });

  test("skill tool with sandbox execution_target resolves to sandbox executionTarget", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "skill_sandbox_tool",
      { query: "test" },
      makeContext(events),
    );

    expect(events.map((event) => event.type)).toEqual(["start", "executed"]);
    const startEvent = events[0];
    if (startEvent.type !== "start") {
      throw new Error("Expected start event");
    }
    expect(startEvent.executionTarget).toBe("sandbox");
    const executed = events[1];
    if (executed.type !== "executed") {
      throw new Error("Expected executed event");
    }
    expect(executed.executionTarget).toBe("sandbox");
  });

  test("does not block tool execution on unresolved lifecycle callbacks", async () => {
    const executor = new ToolExecutor(makePrompter());
    const timeoutMs = 100;

    const resultPromise = executor.execute(
      "file_read",
      {},
      {
        workingDir: "/tmp/project",
        conversationId: "conversation-1",
        trustClass: "guardian",
        onToolLifecycleEvent: () => new Promise<void>(() => {}),
      },
    );

    const raced = Promise.race([
      resultPromise,
      new Promise<ToolExecutionResult>((_, reject) => {
        setTimeout(() => reject(new Error("execute timed out")), timeoutMs);
      }),
    ]);

    await expect(raced).resolves.toMatchObject({
      content: "ok",
      isError: false,
    });
  });

  // ── forcePromptSideEffects lifecycle event tests ──────────

  test("permission_prompt reason reflects side-effect policy for bash under forcePromptSideEffects", async () => {
    checkerDecision = "allow";
    checkerReason = "Matched trust rule";
    checkerRisk = "low";
    promptDecision = "allow";

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "bash",
      { command: "npm install" },
      {
        ...makeContext(events),
        forcePromptSideEffects: true,
      },
    );

    const promptEvent = events.find((e) => e.type === "permission_prompt");
    expect(promptEvent).toBeDefined();
    if (promptEvent?.type !== "permission_prompt") {
      throw new Error("Expected permission_prompt event");
    }
    expect(promptEvent.toolName).toBe("bash");
    expect(promptEvent.reason).toBe(
      "Side-effect tool requires explicit approval",
    );
  });

  test("no permission_prompt event for read-only tool even with forcePromptSideEffects", async () => {
    checkerDecision = "allow";
    checkerReason = "allowed";
    checkerRisk = "low";

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "file_read",
      { path: "/tmp/project/README.md" },
      {
        ...makeContext(events),
        forcePromptSideEffects: true,
      },
    );

    // file_read is not a side-effect tool, so no prompt event should appear
    const promptEvent = events.find((e) => e.type === "permission_prompt");
    expect(promptEvent).toBeUndefined();
    expect(events.map((e) => e.type)).toEqual(["start", "executed"]);
  });

  test("file_edit to guardian persona emits permission_prompt under forcePromptSideEffects", async () => {
    // Security invariant: forced side-effect prompting must prompt even when a
    // trust rule would auto-allow.
    checkerDecision = "allow";
    checkerReason = "Matched trust rule: file_edit:*/users/*.md";
    checkerRisk = "low";
    promptDecision = "allow";

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "file_edit",
      {
        path: "/Users/alice/.vellum/workspace/users/alice.md",
        old_string: "old",
        new_string: "new",
      },
      {
        ...makeContext(events),
        forcePromptSideEffects: true,
      },
    );

    expect(result).toMatchObject({ content: "ok", isError: false });

    const promptEvent = events.find((e) => e.type === "permission_prompt");
    expect(promptEvent).toBeDefined();
    if (promptEvent?.type !== "permission_prompt") {
      throw new Error("Expected permission_prompt event");
    }
    expect(promptEvent.toolName).toBe("file_edit");
    expect(promptEvent.reason).toBe(
      "Side-effect tool requires explicit approval",
    );
  });
});
