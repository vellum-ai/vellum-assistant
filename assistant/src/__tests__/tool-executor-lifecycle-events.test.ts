import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ToolExecutionResult,
  ToolLifecycleEvent,
} from "../tools/types.js";

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
  permissions: {
    mode: "workspace" as const,
  },
};

let checkerDecision: "allow" | "prompt" | "deny" = "allow";
let checkerReason = "allowed";
let checkerRisk = "low";
let promptDecision: "allow" | "always_allow" | "deny" | "always_deny" = "allow";
let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };
let toolThrow: Error | null = null;

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
  classifyRisk: async () => checkerRisk,
  check: async () => ({ decision: checkerDecision, reason: checkerReason }),
  generateAllowlistOptions: () => [
    { label: "exact", description: "exact", pattern: "exact" },
  ],
  generateScopeOptions: () => [{ label: "/tmp", scope: "/tmp" }],
}));

mock.module("../memory/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
}));

mock.module("../tools/registry.js", () => ({
  getTool: (name: string) => {
    if (name === "unknown_tool") return undefined;
    // Skill tools carry origin and executionTarget from their manifest
    if (name === "skill_host_tool") {
      return {
        name,
        description: "skill host tool",
        category: "skill",
        defaultRiskLevel: "low",
        origin: "skill" as const,
        ownerSkillId: "test-skill",
        executionTarget: "host" as const,
        getDefinition: () => ({}),
        execute: async () => {
          if (toolThrow) throw toolThrow;
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
        origin: "skill" as const,
        ownerSkillId: "test-skill",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({}),
        execute: async () => {
          if (toolThrow) throw toolThrow;
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
        origin: "skill" as const,
        ownerSkillId: "test-skill",
        executionTarget: "sandbox" as const,
        getDefinition: () => ({}),
        execute: async () => {
          if (toolThrow) throw toolThrow;
          return fakeToolResult;
        },
      };
    }
    return {
      name,
      description: "test tool",
      category: "test",
      defaultRiskLevel: "low",
      getDefinition: () => ({}),
      execute: async () => {
        if (toolThrow) throw toolThrow;
        return fakeToolResult;
      },
    };
  },
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
import { ToolError } from "../util/errors.js";

function makeContext(events: ToolLifecycleEvent[]) {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass: "guardian" as const,
    onToolLifecycleEvent: (event: ToolLifecycleEvent) => {
      events.push(event);
    },
  };
}

function makePrompter(
  promptImpl?: () => Promise<{
    decision: "allow" | "always_allow" | "deny" | "always_deny";
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

afterAll(() => {
  mock.restore();
});

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

    expect(result).toEqual({ content: "ok", isError: false });
    expect(events.map((event) => event.type)).toEqual(["start", "executed"]);
    expect(events[0]).toMatchObject({
      type: "start",
      toolName: "file_read",
      executionTarget: "sandbox",
      conversationId: "conversation-1",
      workingDir: "/tmp/project",
    });
    const executed = events[1];
    if (executed.type !== "executed")
      throw new Error("Expected executed event");
    expect(executed.executionTarget).toBe("sandbox");
    expect(executed.riskLevel).toBe("low");
    expect(executed.result).toEqual({ content: "ok", isError: false });
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
      makeContext(events),
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain("Permission denied by user");
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "permission_prompt",
      "permission_denied",
    ]);

    const promptEvent = events[1];
    if (promptEvent.type !== "permission_prompt")
      throw new Error("Expected permission_prompt event");
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
    if (deniedEvent.type !== "permission_denied")
      throw new Error("Expected permission_denied event");
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
      makeContext(events),
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

    expect(result).toEqual({ content: "ok", isError: false });
    expect(events.map((event) => event.type)).toEqual(["start", "executed"]);
    const startEvent = events[0];
    if (startEvent.type !== "start") throw new Error("Expected start event");
    expect(startEvent.executionTarget).toBe("host");
    const executed = events[1];
    if (executed.type !== "executed")
      throw new Error("Expected executed event");
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
      makeContext(events),
    );

    expect(result).toEqual({
      content: "Blocked by deny rule: rm *",
      isError: true,
    });
    expect(events.map((event) => event.type)).toEqual([
      "start",
      "permission_denied",
    ]);
    const deniedEvent = events[1];
    if (deniedEvent.type !== "permission_denied")
      throw new Error("Expected permission_denied event");
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
    if (errorEvent.type !== "error") throw new Error("Expected error event");
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
    if (errorEvent.type !== "error") throw new Error("Expected error event");
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
    if (errorEvent.type !== "error") throw new Error("Expected error event");
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
    if (startEvent.type !== "start") throw new Error("Expected start event");
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
    if (startEvent.type !== "start") throw new Error("Expected start event");
    expect(startEvent.executionTarget).toBe("host");
    const executedEvent = events.find(
      (e) => e.type === "executed" || e.type === "error",
    );
    expect(executedEvent?.executionTarget).toBe("host");
  });

  test("skill tool with host execution_target resolves to host executionTarget", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "skill_host_tool",
      { query: "test" },
      makeContext(events),
    );

    expect(events.map((event) => event.type)).toEqual(["start", "executed"]);
    const startEvent = events[0];
    if (startEvent.type !== "start") throw new Error("Expected start event");
    expect(startEvent.executionTarget).toBe("host");
    const executed = events[1];
    if (executed.type !== "executed")
      throw new Error("Expected executed event");
    expect(executed.executionTarget).toBe("host");
  });

  test("manifest executionTarget takes priority over host_ prefix heuristic", async () => {
    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    await executor.execute(
      "host_skill_sandboxed",
      { query: "test" },
      makeContext(events),
    );

    expect(events.map((event) => event.type)).toEqual(["start", "executed"]);
    const startEvent = events[0];
    if (startEvent.type !== "start") throw new Error("Expected start event");
    expect(startEvent.executionTarget).toBe("sandbox");
    const executed = events[1];
    if (executed.type !== "executed")
      throw new Error("Expected executed event");
    expect(executed.executionTarget).toBe("sandbox");
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
    if (startEvent.type !== "start") throw new Error("Expected start event");
    expect(startEvent.executionTarget).toBe("sandbox");
    const executed = events[1];
    if (executed.type !== "executed")
      throw new Error("Expected executed event");
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

    await expect(raced).resolves.toEqual({ content: "ok", isError: false });
  });

  // ── forcePromptSideEffects lifecycle event tests (PR 31) ──────────

  test("emits permission_prompt with private-thread reason when forcePromptSideEffects is true for file_edit", async () => {
    // check() returns allow — simulating a matched trust rule that would
    // normally auto-allow. The forcePromptSideEffects flag should promote
    // this to a prompt.
    checkerDecision = "allow";
    checkerReason = "Matched trust rule";
    checkerRisk = "low";
    promptDecision = "allow";

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "file_edit",
      { path: "/tmp/project/config.ts", old_string: "a", new_string: "b" },
      {
        ...makeContext(events),
        forcePromptSideEffects: true,
      },
    );

    expect(result).toEqual({ content: "ok", isError: false });

    const promptEvent = events.find((e) => e.type === "permission_prompt");
    expect(promptEvent).toBeDefined();
    if (promptEvent?.type !== "permission_prompt")
      throw new Error("Expected permission_prompt event");
    expect(promptEvent.toolName).toBe("file_edit");
    expect(promptEvent.reason).toBe(
      "Private conversation: side-effect tools require explicit approval",
    );
  });

  test("permission_prompt reason reflects private-thread policy for bash under forcePromptSideEffects", async () => {
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
    if (promptEvent?.type !== "permission_prompt")
      throw new Error("Expected permission_prompt event");
    expect(promptEvent.toolName).toBe("bash");
    expect(promptEvent.reason).toBe(
      "Private conversation: side-effect tools require explicit approval",
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

  test("file_edit to USER.md emits permission_prompt under forcePromptSideEffects", async () => {
    // Security invariant: editing USER.md in a private thread must always
    // prompt, even when a trust rule would auto-allow.
    checkerDecision = "allow";
    checkerReason = "Matched trust rule: file_edit:*/USER.md";
    checkerRisk = "low";
    promptDecision = "allow";

    const events: ToolLifecycleEvent[] = [];
    const executor = new ToolExecutor(makePrompter());

    const result = await executor.execute(
      "file_edit",
      {
        path: "/Users/sidd/.vellum/workspace/USER.md",
        old_string: "old",
        new_string: "new",
      },
      {
        ...makeContext(events),
        forcePromptSideEffects: true,
      },
    );

    expect(result).toEqual({ content: "ok", isError: false });

    const promptEvent = events.find((e) => e.type === "permission_prompt");
    expect(promptEvent).toBeDefined();
    if (promptEvent?.type !== "permission_prompt")
      throw new Error("Expected permission_prompt event");
    expect(promptEvent.toolName).toBe("file_edit");
    expect(promptEvent.reason).toBe(
      "Private conversation: side-effect tools require explicit approval",
    );
  });
});
