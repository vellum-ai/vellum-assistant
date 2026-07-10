import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  AllowlistOption,
  PolicyContext,
  ScopeOption,
} from "../permissions/types.js";
import { RiskLevel } from "../permissions/types.js";
import type { Tool, ToolExecutionResult } from "../tools/types.js";
import { createAbortReason } from "../util/abort-reasons.js";

const mockConfig = {
  provider: "anthropic",
  model: "test",
  maxTokens: 4096,
  dataDir: "/tmp",
  timeouts: {
    shellDefaultTimeoutSec: 120,
    shellMaxTimeoutSec: 600,
    permissionTimeoutSec: 300,
    questionResponseTimeoutSec: 1800,
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
  permissions: {},
};

let fakeToolResult: ToolExecutionResult = { content: "ok", isError: false };

/** Captured arguments from the last check() call, for assertion in tests. */
let lastCheckArgs:
  | {
      toolName: string;
      input: Record<string, unknown>;
      workingDir: string;
      policyContext?: PolicyContext;
    }
  | undefined;

/** Optional override for getTool — lets tests supply skill-origin tools. */
let getToolOverride: ((name: string) => Tool | undefined) | undefined;

/** Optional override for getAllTools — lets tests supply a registry snapshot. */
let getAllToolsOverride: (() => Tool[]) | undefined;

/** Override the check() result for tests that need to trigger prompting. */
let checkResultOverride: { decision: string; reason: string } | undefined;

/** Function override for check() — when set, takes precedence over the static override. */
let checkFnOverride:
  | ((
      toolName: string,
      input: Record<string, unknown>,
      workingDir: string,
      policyContext?: PolicyContext,
    ) => Promise<{ decision: string; reason: string }>)
  | undefined;

/** Override for generateScopeOptions — when set, returns this value instead of the default. */
let scopeOptionsOverride: ScopeOption[] | undefined;

/** Override for getCachedAssessment — when set, returns this value. */
let cachedAssessmentOverride:
  | {
      riskLevel: string;
      reason: string;
      scopeOptions: Array<{ pattern: string; label: string }>;
      allowlistOptions?: Array<{
        label: string;
        description: string;
        pattern: string;
      }>;
      directoryScopeOptions?: Array<{ scope: string; label: string }>;
      matchType: string;
    }
  | undefined;

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

mock.module("../permissions/checker.js", () => ({
  isDynamicSkillLoadInvocation: () => false,
  classifyRisk: async () => ({ level: "low" }),
  check: async (
    toolName: string,
    input: Record<string, unknown>,
    workingDir: string,
    policyContext?: PolicyContext,
  ) => {
    lastCheckArgs = { toolName, input, workingDir, policyContext };
    if (checkFnOverride) {
      return checkFnOverride(toolName, input, workingDir, policyContext);
    }
    if (checkResultOverride) {
      return checkResultOverride;
    }
    return { decision: "allow", reason: "allowed" };
  },
  generateAllowlistOptions: () => [
    { label: "exact", description: "exact", pattern: "exact" },
  ],
  generateScopeOptions: () =>
    scopeOptionsOverride ?? [{ label: "/tmp", scope: "/tmp" }],
  getCachedAssessment: () => cachedAssessmentOverride,
}));

// Mock every export so downstream test files that dynamically import modules
// with a static `from "../telemetry/tool-usage-store.js"` still see all symbols.
mock.module("../telemetry/tool-usage-store.js", () => ({
  recordToolInvocation: () => {},
  getRecentInvocations: () => [],
  rotateToolInvocations: async () => 0,
}));

const mockToolLookup = (name: string) => {
  if (getToolOverride) {
    return getToolOverride(name);
  }
  if (name === "unknown_tool") {
    return undefined;
  }
  return {
    name,
    description: "test tool",
    category: "test",
    defaultRiskLevel: "low",
    input_schema: {},
    execute: async () => fakeToolResult,
  };
};

mock.module("../tools/registry.js", () => ({
  getTool: mockToolLookup,
  peekTool: mockToolLookup,
  getAllTools: () => (getAllToolsOverride ? getAllToolsOverride() : []),
  // Ownership lives on the registry post-refactor; production reads it via
  // getToolOwner(name) rather than a field on the Tool object. Mirror that by
  // surfacing the optional `owner`-shaped field from the override-produced
  // tool so existing tests can encode owner inline.
  getToolOwner: (name: string) => {
    const t = getToolOverride?.(name) as
      | { owner?: { kind: "skill" | "mcp" | "plugin"; id: string } }
      | undefined;
    return t?.owner;
  },
}));

mock.module("../tools/shared/filesystem/path-policy.js", () => ({
  sandboxPolicy: () => ({ ok: false }),
  hostPolicy: () => ({ ok: false }),
}));

import { PermissionPrompter } from "../permissions/prompter.js";
import {
  computePerToolTimeoutMs,
  isSideEffectTool,
  ToolExecutor,
} from "../tools/executor.js";
import type { ToolContext } from "../tools/types.js";

function makeContext(overrides?: Partial<ToolContext>): ToolContext {
  return {
    workingDir: "/tmp/project",
    conversationId: "conversation-1",
    trustClass: "guardian",
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

describe("ToolExecutor allowedToolNames gating", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    getAllToolsOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    cachedAssessmentOverride = undefined;
  });

  test("executes normally when allowedToolNames is not set", async () => {
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("executes normally when tool is in the allowed set", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["file_read", "file_write", "bash"]);
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("canonicalizes app-builder create_app alias before active-tool gating", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["app_create"]);
    const result = await executor.execute(
      "create_app",
      { name: "Calculator" },
      makeContext({ allowedToolNames: allowed }),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
  });

  test("canonicalizes legacy computer_use_press_key alias before active-tool gating", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["computer_use_key"]);
    const result = await executor.execute(
      "computer_use_press_key",
      {
        key: "Space",
        modifiers: ["Command"],
        reasoning: "Open Spotlight",
      },
      makeContext({ allowedToolNames: allowed }),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
    expect(lastCheckArgs?.toolName).toBe("computer_use_key");
    expect(lastCheckArgs?.input).toEqual({
      key: "cmd+space",
      reasoning: "Open Spotlight",
    });
  });

  test("lowercases legacy computer_use_press_key key-only input", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["computer_use_key"]);
    const result = await executor.execute(
      "computer_use_press_key",
      {
        key: "Space",
        reasoning: "Pause media",
      },
      makeContext({ allowedToolNames: allowed }),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs?.toolName).toBe("computer_use_key");
    expect(lastCheckArgs?.input).toEqual({
      key: "space",
      reasoning: "Pause media",
    });
  });

  test("preserves exact active create_app tool before applying compatibility aliases", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["create_app", "app_create"]);
    const result = await executor.execute(
      "create_app",
      { name: "Custom App" },
      makeContext({ allowedToolNames: allowed }),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs?.toolName).toBe("create_app");
  });

  test("blocks execution when tool is NOT in the allowed set", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["file_read", "bash"]);
    const result = await executor.execute(
      "file_write",
      { path: "test.txt", content: "hello" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("not available in this context");
  });

  test("error message includes the blocked tool name and the active set", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["bash"]);
    const result = await executor.execute(
      "file_edit",
      { path: "x" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      'Tool "file_edit" is not available in this context. Available tools: bash',
    );
  });

  test("empty allowed set blocks all tools", async () => {
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set<string>();
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("file_read");
    expect(result.content).toContain("No tools are active this turn");
  });

  test("unknown tool suggestion list is scoped to allowedToolNames", async () => {
    // Surfacing every globally registered tool would leak tools active in
    // other sessions and misdirect the model to tools it cannot invoke.
    const makeTool = (name: string): Tool =>
      ({
        name,
        description: "test tool",
        category: "test",
        defaultRiskLevel: RiskLevel.Low,
        input_schema: { type: "object" as const, properties: {} },
        execute: async () => fakeToolResult,
      }) as unknown as Tool;
    getAllToolsOverride = () => [
      makeTool("file_read"),
      makeTool("file_write"),
      makeTool("secret_skill_tool"),
    ];
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["file_read", "file_write"]);
    const result = await executor.execute(
      "unknown_tool",
      { foo: "bar" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Unknown tool: unknown_tool. Available tools: file_read, file_write",
    );
    expect(result.content).not.toContain("secret_skill_tool");
  });

  test("unknown tool name reports 'Unknown tool' even when allowedToolNames is set", async () => {
    // Regression: a hallucinated tool name with allowedToolNames set used to
    // hit the "not currently active. Load the skill that provides this tool
    // first." gate, which sent the model chasing a nonexistent skill. The
    // registry-lookup gate runs first now so the model sees the real list.
    const executor = new ToolExecutor(makePrompter());
    const allowed = new Set(["file_read"]);
    const result = await executor.execute(
      "unknown_tool",
      { foo: "bar" },
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain("Unknown tool: unknown_tool");
    expect(result.content).not.toContain("not currently active");
  });

  test("inactive skill tool names the owning skill in the load hint", async () => {
    const executor = new ToolExecutor(makePrompter());
    getToolOverride = (name: string) => {
      if (name !== "skill_tool_x") {
        return undefined;
      }
      return {
        name,
        description: "tool from a skill",
        category: "skill",
        defaultRiskLevel: RiskLevel.Low,
        executionTarget: "sandbox" as const,
        owner: { kind: "skill", id: "my-skill" },
        input_schema: { type: "object" as const, properties: {} },
        execute: async () => fakeToolResult,
      };
    };
    const allowed = new Set(["file_read"]);
    const result = await executor.execute(
      "skill_tool_x",
      {},
      makeContext({ allowedToolNames: allowed }),
    );
    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      'Tool "skill_tool_x" is not currently active. Load the "my-skill" skill that provides this tool first.',
    );
  });
});

describe("ToolExecutor policy context plumbing", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    cachedAssessmentOverride = undefined;
  });

  test("passes PolicyContext with executionTarget for skill-origin tools", async () => {
    getToolOverride = (name: string) => {
      if (name === "unknown_tool") {
        return undefined;
      }
      return {
        name,
        description: "skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.Low,
        owner: { kind: "skill", id: "my-skill-123" },
        executionTarget: "sandbox" as const,
        input_schema: { type: "object" as const, properties: {} },
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "skill_tool",
      { action: "run" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      conversationId: "conversation-1",
      executionContext: "conversation",
      executionTarget: "sandbox",
      // Origin-scoping signal: buildPolicyContext now copies the turn's trust
      // class onto the PolicyContext so the checker can scope narrow
      // non-interactive auto-grants. requestOrigin/sourceChannel are unset for
      // this interactive turn (omitted — toEqual ignores undefined-valued keys).
      trustClass: "guardian",
      // buildPolicyContext also precomputes the proc-to-skills gate (flag on AND
      // v3 live) so the leaf permission checker can read it without touching
      // config. This test does not mock memory-v3-gate.js, so the real gate runs
      // against the default config and resolves inactive → false.
      procToSkillsActive: false,
    });
  });

  test("passes undefined policyContext for core tools (no origin)", async () => {
    // Default getTool returns core tools with no origin field
    getToolOverride = undefined;

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "test.txt" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      conversationId: "conversation-1",
      executionContext: "conversation",
      // Trust class is now threaded onto the PolicyContext (see above).
      trustClass: "guardian",
      // Real (unmocked) proc-to-skills gate resolves inactive (see above).
      procToSkillsActive: false,
    });
  });

  test('passes undefined policyContext for tools with origin "core"', async () => {
    getToolOverride = (name: string) => {
      if (name === "unknown_tool") {
        return undefined;
      }
      return {
        name,
        description: "core tool",
        category: "core",
        defaultRiskLevel: RiskLevel.Low,
        executionTarget: "sandbox" as const,
        input_schema: { type: "object" as const, properties: {} },
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "test.txt" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      conversationId: "conversation-1",
      executionContext: "conversation",
      // Trust class is now threaded onto the PolicyContext (see above).
      trustClass: "guardian",
      // Real (unmocked) proc-to-skills gate resolves inactive (see above).
      procToSkillsActive: false,
    });
  });

  test('includes executionTarget "host" from skill tool metadata', async () => {
    getToolOverride = (name: string) => {
      if (name === "unknown_tool") {
        return undefined;
      }
      return {
        name,
        description: "host skill tool",
        category: "skill",
        defaultRiskLevel: RiskLevel.Low,
        owner: { kind: "skill", id: "host-skill" },
        executionTarget: "host" as const,
        input_schema: { type: "object" as const, properties: {} },
        execute: async () => fakeToolResult,
      };
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "host_skill_tool",
      { action: "run" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(false);
    expect(lastCheckArgs).toBeDefined();
    expect(lastCheckArgs!.policyContext).toEqual({
      conversationId: "conversation-1",
      executionContext: "conversation",
      executionTarget: "host",
      // Trust class is now threaded onto the PolicyContext (see above).
      trustClass: "guardian",
      // Real (unmocked) proc-to-skills gate resolves inactive (see above).
      procToSkillsActive: false,
    });
  });
});

// ---------------------------------------------------------------------------
// isSideEffectTool classifier
// ---------------------------------------------------------------------------

describe("isSideEffectTool", () => {
  describe("returns true for side-effect tools", () => {
    const sideEffectTools = [
      "file_write",
      "file_edit",
      "host_file_write",
      "host_file_edit",
      "bash",
      "host_bash",
      "web_fetch",
      "document_create",
      "document_update",
      "document_delete",
      "schedule_create",
      "schedule_update",
      "schedule_delete",
    ];

    for (const toolName of sideEffectTools) {
      test(toolName, () => {
        expect(isSideEffectTool(toolName)).toBe(true);
      });
    }
  });

  describe("returns false for non-side-effect tools", () => {
    const readOnlyTools = [
      "file_read",
      "memory_recall",
      "memory_manage",
      "web_search",
      "browser_navigate",
      "browser_click",
      "browser_type",
      "browser_press_key",
      "browser_close",
      "browser_attach",
      "browser_detach",
      "browser_fill_credential",
      "browser_snapshot",
      "browser_screenshot",
      "browser_wait_for",
      "browser_extract",
      "skill_load",
      "schedule_list",
    ];

    for (const toolName of readOnlyTools) {
      test(toolName, () => {
        expect(isSideEffectTool(toolName)).toBe(false);
      });
    }
  });

  test("returns false for unknown tool names", () => {
    expect(isSideEffectTool("nonexistent_tool")).toBe(false);
    expect(isSideEffectTool("")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// forcePromptSideEffects enforcement (PR 30)
// ---------------------------------------------------------------------------

describe("ToolExecutor forcePromptSideEffects enforcement", () => {
  let promptCalled: boolean;

  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    cachedAssessmentOverride = undefined;
    promptCalled = false;
  });

  /**
   * Prompter that tracks whether it was called and always allows.
   */
  function makeTrackingPrompter(): PermissionPrompter {
    return {
      prompt: async () => {
        promptCalled = true;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;
  }

  test("side-effect tool with allow rule is forced to prompt when forcePromptSideEffects is true", async () => {
    // check() returns allow (simulating a matched trust rule)
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "bash",
      { command: "echo hello" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // The prompter must have been called despite the allow rule
    expect(promptCalled).toBe(true);
  });

  test("deny decision is preserved (not converted to prompt) even with forcePromptSideEffects", async () => {
    checkResultOverride = {
      decision: "deny",
      reason: "Policy denies this tool",
    };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "bash",
      { command: "rm -rf /" },
      makeContext({ forcePromptSideEffects: true }),
    );

    // Should be denied, not prompted
    expect(result.isError).toBe(true);
    expect(result.content).toBe("Policy denies this tool");
    expect(promptCalled).toBe(false);
  });

  test("non-side-effect tool is unchanged even with forcePromptSideEffects", async () => {
    // check() returns allow for a read-only tool
    checkResultOverride = { decision: "allow", reason: "Allowed by default" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // Prompter should NOT be called — file_read is not a side-effect tool
    expect(promptCalled).toBe(false);
  });

  test("side-effect tool is auto-allowed when forcePromptSideEffects is false", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "file_write",
      { path: "test.txt", content: "data" },
      makeContext({ forcePromptSideEffects: false }),
    );

    expect(result.isError).toBe(false);
    // No prompt — standard behavior when forcePromptSideEffects is off
    expect(promptCalled).toBe(false);
  });

  test("side-effect tool is auto-allowed when forcePromptSideEffects is undefined", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "file_edit",
      { path: "test.txt", old_string: "a", new_string: "b" },
      makeContext(), // forcePromptSideEffects not set
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(false);
  });

  test("all side-effect tool types are forced to prompt", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const sideEffectTools = [
      { name: "file_write", input: { path: "x", content: "y" } },
      {
        name: "file_edit",
        input: { path: "x", old_string: "a", new_string: "b" },
      },
      { name: "host_file_write", input: { path: "x", content: "y" } },
      {
        name: "host_file_edit",
        input: { path: "x", old_string: "a", new_string: "b" },
      },
      { name: "bash", input: { command: "echo hi" } },
      { name: "host_bash", input: { command: "echo hi" } },
      { name: "web_fetch", input: { url: "https://example.com" } },
      { name: "document_create", input: { title: "doc", content: "body" } },
      { name: "document_update", input: { id: "doc-1", content: "updated" } },
      { name: "document_delete", input: { surface_id: "doc-1" } },
    ];

    for (const { name, input } of sideEffectTools) {
      promptCalled = false;
      const executor = new ToolExecutor(makeTrackingPrompter());
      const result = await executor.execute(
        name,
        input,
        makeContext({ forcePromptSideEffects: true }),
      );
      expect(result.isError).toBe(false);
      expect(promptCalled).toBe(true);
    }
  });

  test("tool that is already prompted is not double-prompted", async () => {
    // check() returns prompt (tool already needs prompting)
    checkResultOverride = {
      decision: "prompt",
      reason: "Medium risk: requires approval",
    };

    let promptCount = 0;
    const countingPrompter = {
      prompt: async () => {
        promptCount++;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(countingPrompter);
    const result = await executor.execute(
      "bash",
      { command: "ls" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // Should only prompt once — forcePromptSideEffects doesn't add a second prompt
    // when check() already returned 'prompt'
    expect(promptCount).toBe(1);
  });

  // ── Always-mutating schedule tools ──────────

  test("schedule_delete forces prompt under forcePromptSideEffects", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "schedule_delete",
      { id: "sched-1" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  // ── Workspace mode + forcePromptSideEffects interaction ──────────

  test("workspace mode allow → prompt promotion still works for side-effect tools under forcePromptSideEffects", async () => {
    // Simulate workspace mode returning 'allow' for a workspace-scoped file_write
    checkResultOverride = {
      decision: "allow",
      reason: "Workspace-scoped low-risk operation auto-allowed",
    };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "file_write",
      { path: "/tmp/project/test.txt", content: "data" },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // file_write is a side-effect tool, so forcePromptSideEffects must promote
    // the workspace mode allow → prompt, requiring explicit user approval
    expect(promptCalled).toBe(true);
  });

  test("schedule_create forces prompt under forcePromptSideEffects", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "schedule_create",
      {
        name: "test schedule",
        expression: "0 9 * * *",
        message: "test",
      },
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    expect(promptCalled).toBe(true);
  });

  test("schedule_list does NOT force prompt under forcePromptSideEffects", async () => {
    checkResultOverride = { decision: "allow", reason: "Matched trust rule" };

    const executor = new ToolExecutor(makeTrackingPrompter());
    const result = await executor.execute(
      "schedule_list",
      {},
      makeContext({ forcePromptSideEffects: true }),
    );

    expect(result.isError).toBe(false);
    // list is read-only — must NOT trigger forced prompting
    expect(promptCalled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Baseline: sanitized env excludes credential-like variables
// ---------------------------------------------------------------------------

// Import the real buildSanitizedEnv (not mocked) for baseline credential tests
const {
  buildSanitizedEnv,
  KATA_INJECTED_ENV_VARS,
  KATA_SAFE_ENV_VARS,
  SAFE_ENV_VARS,
  ALWAYS_INJECTED_ENV_VARS,
} = await import("../tools/terminal/safe-env.js");

describe("buildSanitizedEnv — baseline: credential exclusion", () => {
  // Credential-like env vars that must never appear in the sanitized env.
  // Names are constructed dynamically to avoid tripping pre-commit secret scanners.
  const k = (...parts: string[]) => parts.join("_");
  const CREDENTIAL_VARS = [
    k("OPENAI", "API", "KEY"),
    k("ANTHROPIC", "API", "KEY"),
    k("AWS", "SECRET", "ACCESS", "KEY"),
    k("AWS", "SESSION", "TOKEN"),
    k("GITHUB", "TOKEN"),
    k("GH", "TOKEN"),
    k("NPM", "TOKEN"),
    k("DOCKER", "PASSWORD"),
    k("DATABASE", "URL"),
    k("PGPASSWORD"),
    k("REDIS", "URL"),
    k("API", "SECRET"),
  ];

  test("sanitized env does not include API key variables", () => {
    // Temporarily set credential-like env vars
    const originalValues: Record<string, string | undefined> = {};
    for (const key of CREDENTIAL_VARS) {
      originalValues[key] = process.env[key];
      process.env[key] = `fake-${key}-value`;
    }

    try {
      const env = buildSanitizedEnv();
      for (const key of CREDENTIAL_VARS) {
        expect(env[key]).toBeUndefined();
      }
    } finally {
      // Restore original env
      for (const key of CREDENTIAL_VARS) {
        if (originalValues[key] === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = originalValues[key];
        }
      }
    }
  });

  test("sanitized env includes expected safe variables when present", () => {
    const env = buildSanitizedEnv();
    // PATH and HOME should be present (they exist in the process env)
    if (process.env.PATH) {
      expect(env.PATH).toBe(process.env.PATH);
    }
    if (process.env.HOME) {
      expect(env.HOME).toBe(process.env.HOME);
    }
  });

  test("sanitized env only contains keys from the allowlist", () => {
    const allowed: string[] = [
      ...SAFE_ENV_VARS,
      ...KATA_SAFE_ENV_VARS,
      ...KATA_INJECTED_ENV_VARS,
      ...ALWAYS_INJECTED_ENV_VARS,
    ];
    const env = buildSanitizedEnv();
    for (const key of Object.keys(env)) {
      expect(allowed).toContain(key);
    }
  });
});

describe("integration regressions — prompt payload (PR 11)", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    getToolOverride = undefined;
  });

  test("shell command prompt payload includes allowlist and scope options", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "Medium risk: requires approval",
    };

    let capturedAllowlist: AllowlistOption[] | undefined;
    let capturedScopes: ScopeOption[] | undefined;
    const prompter = {
      prompt: async (
        _toolName: string,
        _input: Record<string, unknown>,
        _riskLevel: string,
        allowlistOptions: AllowlistOption[],
        scopeOptions: ScopeOption[],
      ) => {
        capturedAllowlist = allowlistOptions;
        capturedScopes = scopeOptions;
        return { decision: "allow" as const };
      },
      resolveConfirmation: () => {},
      updateSender: () => {},
      dispose: () => {},
    } as unknown as PermissionPrompter;

    const executor = new ToolExecutor(prompter);
    await executor.execute(
      "bash",
      { command: "npm install" },
      makeContext({ forcePromptSideEffects: true }),
    );

    // Verify that the prompter received allowlist options
    expect(capturedAllowlist).toBeDefined();
    expect(capturedAllowlist!.length).toBeGreaterThan(0);
    // The mock returns [{label: 'exact', description: 'exact', pattern: 'exact'}]
    expect(capturedAllowlist![0]).toHaveProperty("pattern");
    expect(capturedAllowlist![0]).toHaveProperty("label");
    expect(capturedAllowlist![0]).toHaveProperty("description");

    // Verify scope options are also passed
    expect(capturedScopes).toBeDefined();
    expect(capturedScopes!.length).toBeGreaterThan(0);
    expect(capturedScopes![0]).toHaveProperty("scope");
  });
});

// ---------------------------------------------------------------------------
// Risk metadata on ToolExecutionResult (PR 5 — scope-ladder-v1)
// ---------------------------------------------------------------------------

describe("ToolExecutionResult includes risk metadata from classifier assessment", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    lastCheckArgs = undefined;
    getToolOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    cachedAssessmentOverride = undefined;
  });

  test("auto-approved tool result includes risk metadata when classifier assessment exists", async () => {
    cachedAssessmentOverride = {
      riskLevel: "medium",
      reason: "Writes to a file outside the workspace",
      scopeOptions: [
        { pattern: "file_write:/tmp/test.txt", label: "This file only" },
        { pattern: "file_write:/tmp/**", label: "Anything in tmp/" },
      ],
      matchType: "registry",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(false);
    expect(result.riskLevel).toBe("medium");
    expect(result.riskReason).toBe("Writes to a file outside the workspace");
    expect(result.riskScopeOptions).toEqual([
      { pattern: "file_write:/tmp/test.txt", label: "This file only" },
      { pattern: "file_write:/tmp/**", label: "Anything in tmp/" },
    ]);
  });

  test("tool result omits risk metadata when no classifier assessment exists (e.g. MCP tools)", async () => {
    // cachedAssessmentOverride is undefined (no classifier ran)
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.riskLevel).toBeUndefined();
    expect(result.riskReason).toBeUndefined();
    expect(result.riskScopeOptions).toBeUndefined();
  });

  test("denied tool result includes risk metadata", async () => {
    checkResultOverride = {
      decision: "deny",
      reason: "Blocked by deny rule",
    };
    cachedAssessmentOverride = {
      riskLevel: "high",
      reason: "Recursive force delete",
      scopeOptions: [{ pattern: "bash:rm -rf*", label: "rm -rf commands" }],
      matchType: "registry",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "rm -rf /" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.riskLevel).toBe("high");
    expect(result.riskReason).toBe("Recursive force delete");
    expect(result.riskScopeOptions).toEqual([
      { pattern: "bash:rm -rf*", label: "rm -rf commands" },
    ]);
  });

  test("prompted-then-approved tool result includes risk metadata", async () => {
    checkResultOverride = {
      decision: "prompt",
      reason: "Medium risk: requires approval",
    };
    cachedAssessmentOverride = {
      riskLevel: "medium",
      reason: "Package manager installation",
      scopeOptions: [
        { pattern: "bash:npm install*", label: "npm install commands" },
        { pattern: "bash:npm*", label: "All npm commands" },
      ],
      matchType: "registry",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "bash",
      { command: "npm install lodash" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(false);
    expect(result.content).toBe("ok");
    expect(result.riskLevel).toBe("medium");
    expect(result.riskReason).toBe("Package manager installation");
    expect(result.riskScopeOptions).toHaveLength(2);
  });

  test("tool result includes riskDirectoryScopeOptions when classifier emits directoryScopeOptions", async () => {
    cachedAssessmentOverride = {
      riskLevel: "medium",
      reason: "Writes to file in workspace",
      scopeOptions: [
        {
          pattern: "file_write:/workspace/scratch/out.txt",
          label: "This file only",
        },
      ],
      directoryScopeOptions: [
        { scope: "/workspace/scratch", label: "In scratch/" },
        { scope: "/workspace", label: "Anywhere in workspace/" },
        { scope: "everywhere", label: "Everywhere" },
      ],
      matchType: "registry",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "/workspace/scratch/out.txt" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(false);
    expect(result.riskDirectoryScopeOptions).toEqual([
      { scope: "/workspace/scratch", label: "In scratch/" },
      { scope: "/workspace", label: "Anywhere in workspace/" },
      { scope: "everywhere", label: "Everywhere" },
    ]);
  });

  test("tool result omits riskDirectoryScopeOptions when classifier does not emit directoryScopeOptions", async () => {
    cachedAssessmentOverride = {
      riskLevel: "low",
      reason: "Read-only operation",
      scopeOptions: [],
      // directoryScopeOptions intentionally omitted
      matchType: "registry",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.riskDirectoryScopeOptions).toBeUndefined();
  });

  test("riskScopeOptions and riskDirectoryScopeOptions are independent — one does not clobber the other", async () => {
    cachedAssessmentOverride = {
      riskLevel: "medium",
      reason: "Filesystem write",
      scopeOptions: [
        { pattern: "file_write:/tmp/foo.txt", label: "This file" },
      ],
      directoryScopeOptions: [{ scope: "/tmp", label: "Anywhere in tmp/" }],
      matchType: "registry",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "/tmp/foo.txt" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.riskScopeOptions).toEqual([
      { pattern: "file_write:/tmp/foo.txt", label: "This file" },
    ]);
    expect(result.riskDirectoryScopeOptions).toEqual([
      { scope: "/tmp", label: "Anywhere in tmp/" },
    ]);
  });

  test("auto-approved tool result includes riskAllowlistOptions when classifier emits them (Minimatch-glob shape for save path)", async () => {
    cachedAssessmentOverride = {
      riskLevel: "medium",
      reason: "Reads workspace files",
      // Display ladder (regex shape — not for save).
      scopeOptions: [
        { pattern: "^echo\\b.*hello$", label: "echo hello" },
        { pattern: "^echo\\b", label: "echo *" },
      ],
      // Save ladder (Minimatch-glob shape — what gateway matches against).
      allowlistOptions: [
        {
          label: "echo hello",
          description: "This exact command",
          pattern: "echo hello",
        },
        {
          label: "echo *",
          description: "Any echo command",
          pattern: "action:echo",
        },
      ],
      matchType: "registry",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(false);
    // Both shapes flow through independently — same labels, different patterns.
    expect(result.riskScopeOptions).toEqual([
      { pattern: "^echo\\b.*hello$", label: "echo hello" },
      { pattern: "^echo\\b", label: "echo *" },
    ]);
    expect(result.riskAllowlistOptions).toEqual([
      {
        label: "echo hello",
        description: "This exact command",
        pattern: "echo hello",
      },
      {
        label: "echo *",
        description: "Any echo command",
        pattern: "action:echo",
      },
    ]);
  });

  test("riskAllowlistOptions is undefined when classifier did not produce allowlist (e.g. web-risk classifier)", async () => {
    cachedAssessmentOverride = {
      riskLevel: "low",
      reason: "GET request to public URL",
      scopeOptions: [
        { pattern: "https://example.com/.*", label: "example.com" },
      ],
      // allowlistOptions intentionally omitted — some classifiers don't emit them.
      matchType: "registry",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(false);
    // Display ladder still flows; save ladder is absent so the client must
    // fall back to a synthesized option (or omit save).
    expect(result.riskScopeOptions).toEqual([
      { pattern: "https://example.com/.*", label: "example.com" },
    ]);
    expect(result.riskAllowlistOptions).toBeUndefined();
  });

  test("riskAllowlistOptions is undefined when no classifier ran (MCP tools)", async () => {
    // cachedAssessmentOverride is undefined — no classifier ran.
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "README.md" },
      makeContext(),
    );

    expect(result.isError).toBe(false);
    expect(result.riskScopeOptions).toBeUndefined();
    expect(result.riskAllowlistOptions).toBeUndefined();
  });

  test("denied tool result still carries riskAllowlistOptions for the rule editor save path", async () => {
    checkResultOverride = { decision: "deny", reason: "Blocked by deny rule" };
    cachedAssessmentOverride = {
      riskLevel: "high",
      reason: "Recursive force delete",
      scopeOptions: [{ pattern: "^rm\\s+-rf", label: "rm -rf *" }],
      allowlistOptions: [
        {
          label: "rm -rf *",
          description: "Any rm -rf command",
          pattern: "action:rm",
        },
      ],
      matchType: "registry",
    };

    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute(
      "file_read",
      { path: "anything" },
      makeContext({ requireFreshApproval: true }),
    );

    expect(result.isError).toBe(true);
    expect(result.riskAllowlistOptions).toEqual([
      {
        label: "rm -rf *",
        description: "Any rm -rf command",
        pattern: "action:rm",
      },
    ]);
  });
});

describe("computePerToolTimeoutMs ask_question budget", () => {
  // Regression guard: ask_question blocks on user input inside execute() via
  // QuestionPrompter, which waits up to questionResponseTimeoutSec. The
  // executor's generic toolExecutionTimeoutSec wrapper must give ask_question a
  // budget strictly larger than that prompt timeout — otherwise the wrapper
  // fires first and orphans the still-pending prompt behind the confusing "may
  // still be running in the background" error. These assertions fail if the
  // special case is removed and ask_question falls back to the generic budget,
  // or if the executor budget and the prompter timeout drift onto different
  // config knobs.
  test("execution-timeout budget exceeds the prompt's own questionResponseTimeoutSec", () => {
    const { questionResponseTimeoutSec } = mockConfig.timeouts;
    const askQuestionBudgetMs = computePerToolTimeoutMs("ask_question", {});

    expect(askQuestionBudgetMs).toBeGreaterThan(
      questionResponseTimeoutSec * 1000,
    );
    expect(askQuestionBudgetMs).toBe((questionResponseTimeoutSec + 5) * 1000);
  });

  test("the generic budget that would otherwise apply is shorter than the prompt timeout", () => {
    const { questionResponseTimeoutSec } = mockConfig.timeouts;
    const genericBudgetMs = computePerToolTimeoutMs("some_other_tool", {});

    // This is the collision the ask_question special case fixes: the generic
    // execution-timeout budget is shorter than the prompter's own wait, so
    // without the special case the wrapper trips first.
    expect(genericBudgetMs).toBeLessThan(questionResponseTimeoutSec * 1000);
  });
});

describe("ToolExecutor thrown-value rendering", () => {
  beforeEach(() => {
    fakeToolResult = { content: "ok", isError: false };
    getToolOverride = undefined;
    getAllToolsOverride = undefined;
    checkResultOverride = undefined;
    checkFnOverride = undefined;
    cachedAssessmentOverride = undefined;
  });

  function throwingTool(name: string, thrown: unknown): void {
    getToolOverride = (n: string) =>
      n === name
        ? ({
            name,
            description: "throwing tool",
            category: "test",
            defaultRiskLevel: RiskLevel.Low,
            executionTarget: "sandbox" as const,
            input_schema: { type: "object" as const, properties: {} },
            execute: async () => {
              throw thrown;
            },
          } as Tool)
        : undefined;
  }

  test("a tagged AbortReason renders as a cancellation, not [object Object]", async () => {
    throwingTool("web_search", createAbortReason("user_cancel", "test"));
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute("web_search", {}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toBe("Tool execution was cancelled (user_cancel).");
    expect(result.content).not.toContain("[object Object]");
  });

  test("an AbortError carrying a tagged reason names the cancellation kind", async () => {
    const err = Object.assign(new Error("The operation was aborted"), {
      name: "AbortError",
      reason: createAbortReason("preempted_by_new_message", "test"),
    });
    throwingTool("web_search", err);
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute("web_search", {}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toBe(
      "Tool execution was cancelled (preempted_by_new_message).",
    );
  });

  test("a thrown plain object renders as JSON, not [object Object]", async () => {
    throwingTool("web_search", { status: 429, error: "rate_limited" });
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute("web_search", {}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain('{"status":429,"error":"rate_limited"}');
    expect(result.content).not.toContain("[object Object]");
  });

  test("a thrown string passes through unchanged", async () => {
    throwingTool("web_search", "boom");
    const executor = new ToolExecutor(makePrompter());
    const result = await executor.execute("web_search", {}, makeContext());

    expect(result.isError).toBe(true);
    expect(result.content).toContain("unexpected error: boom");
  });
});
