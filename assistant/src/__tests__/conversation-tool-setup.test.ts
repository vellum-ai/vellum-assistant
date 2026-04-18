/**
 * Tests for the legacy skill_execute browser bridge in createToolExecutor.
 *
 * When browser_* wrapper tools are removed from the registry, old
 * conversation histories that still emit skill_execute(tool="browser_*")
 * must route through executeBrowserOperation so they don't hard-fail.
 * Non-browser skill_execute semantics must remain unchanged.
 */

import { describe, expect, mock, test } from "bun:test";

import type { ToolSetupContext } from "../daemon/conversation-tool-setup.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { ToolContext, ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

mock.module("../daemon/conversation-surfaces.js", () => ({
  refreshSurfacesForApp: mock(() => {}),
  surfaceProxyResolver: mock(() =>
    Promise.resolve({ content: "", isError: false }),
  ),
}));

mock.module("../services/published-app-updater.js", () => ({
  updatePublishedAppDeployment: mock(() => Promise.resolve()),
}));

mock.module("../tools/browser/browser-screencast.js", () => ({
  registerConversationSender: mock(() => {}),
}));

// Track calls to executeBrowserOperation
let executeBrowserOperationCalls: Array<{
  operation: string;
  input: Record<string, unknown>;
}> = [];
let executeBrowserOperationResult: ToolExecutionResult = {
  content: "browser op result",
  isError: false,
};

mock.module("../browser/operations.js", () => ({
  executeBrowserOperation: mock(
    async (
      operation: string,
      input: Record<string, unknown>,
      _context: ToolContext,
    ) => {
      executeBrowserOperationCalls.push({ operation, input });
      return executeBrowserOperationResult;
    },
  ),
}));

// Control whether getTool returns a tool for a given name
let registeredToolNames = new Set<string>();

mock.module("../tools/registry.js", () => ({
  getAllToolDefinitions: () => [],
  getMcpToolDefinitions: () => [],
  getTool: (name: string) => {
    if (registeredToolNames.has(name)) {
      return {
        name,
        description: "test tool",
        category: "test",
        defaultRiskLevel: "low",
        getDefinition: () => ({}),
        execute: async () => ({ content: "ok", isError: false }),
      };
    }
    return undefined;
  },
}));

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createToolExecutor } from "../daemon/conversation-tool-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolSetupContext> = {}): ToolSetupContext {
  return {
    conversationId: "conv-browser-bridge",
    currentRequestId: "req-1",
    workingDir: "/tmp/test",
    abortController: null,
    traceEmitter: { emit: () => {} },
    sendToClient: mock(() => {}),
    pendingSurfaceActions: new Map(),
    lastSurfaceAction: new Map(),
    surfaceState: new Map<
      string,
      { surfaceType: SurfaceType; data: SurfaceData; title?: string }
    >(),
    surfaceUndoStacks: new Map(),
    accumulatedSurfaceState: new Map(),
    surfaceActionRequestIds: new Set<string>(),
    currentTurnSurfaces: [],
    isProcessing: () => false,
    enqueueMessage: () => ({ queued: false, requestId: "r" }),
    getQueueDepth: () => 0,
    processMessage: async () => "",
    withSurface: async <T>(_id: string, fn: () => T | Promise<T>) => fn(),
    memoryPolicy: { scopeId: "default", strictSideEffects: false },
    ...overrides,
  };
}

/** Executor spy that captures calls to execute(). */
function makeCapturingExecutor(
  result: ToolExecutionResult = { content: "ok", isError: false },
) {
  const calls: Array<{ name: string; input: Record<string, unknown> }> = [];
  return {
    executor: {
      execute: mock(
        async (
          name: string,
          input: Record<string, unknown>,
          _ctx: ToolContext,
        ) => {
          calls.push({ name, input });
          return result;
        },
      ),
    },
    getCalls: () => calls,
  };
}

const noopPrompter = {
  prompt: mock(async () => ({ decision: "allow" as const })),
} as unknown as PermissionPrompter;
const noopSecretPrompter = {
  prompt: mock(async () => ({ cancelled: true })),
} as unknown as SecretPrompter;
const noopLifecycleHandler = mock(() => {});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("createToolExecutor — legacy skill_execute browser bridge", () => {
  test("legacy skill_execute(tool='browser_navigate') routes through executeBrowserOperation when no registered tool", async () => {
    // No browser tools in the registry (simulates post-removal state)
    registeredToolNames = new Set<string>();
    executeBrowserOperationCalls = [];
    executeBrowserOperationResult = {
      content: "Navigated to https://example.com",
      isError: false,
    };

    const ctx = makeCtx();
    const { executor, getCalls } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    const result = await toolFn("skill_execute", {
      tool: "browser_navigate",
      input: { url: "https://example.com" },
    });

    // Should have routed through executeBrowserOperation, not the executor
    expect(executeBrowserOperationCalls).toHaveLength(1);
    expect(executeBrowserOperationCalls[0].operation).toBe("navigate");
    expect(executeBrowserOperationCalls[0].input).toEqual({
      url: "https://example.com",
    });
    expect(getCalls()).toHaveLength(0);
    expect(result.isError).toBe(false);
    expect(result.content).toBe("Navigated to https://example.com");
  });

  test("legacy skill_execute(tool='browser_click') routes through executeBrowserOperation when no registered tool", async () => {
    registeredToolNames = new Set<string>();
    executeBrowserOperationCalls = [];
    executeBrowserOperationResult = {
      content: "Clicked element",
      isError: false,
    };

    const ctx = makeCtx();
    const { executor, getCalls } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    const result = await toolFn("skill_execute", {
      tool: "browser_click",
      input: { selector: "#submit" },
    });

    expect(executeBrowserOperationCalls).toHaveLength(1);
    expect(executeBrowserOperationCalls[0].operation).toBe("click");
    expect(getCalls()).toHaveLength(0);
    expect(result.isError).toBe(false);
  });

  test("browser_* tool uses normal executor path when tool IS registered", async () => {
    // Simulate browser tools still being registered
    registeredToolNames = new Set(["browser_navigate"]);
    executeBrowserOperationCalls = [];

    const ctx = makeCtx();
    const { executor, getCalls } = makeCapturingExecutor({
      content: "executor result",
      isError: false,
    });

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    const result = await toolFn("skill_execute", {
      tool: "browser_navigate",
      input: { url: "https://example.com" },
    });

    // Should have used the normal executor, NOT executeBrowserOperation
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0].name).toBe("browser_navigate");
    expect(executeBrowserOperationCalls).toHaveLength(0);
    expect(result.content).toBe("executor result");
  });

  test("unknown non-browser tool still fails through executor as before", async () => {
    registeredToolNames = new Set<string>();
    executeBrowserOperationCalls = [];

    const ctx = makeCtx();
    const { executor, getCalls } = makeCapturingExecutor({
      content: "Unknown tool: some_random_tool",
      isError: true,
    });

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    const result = await toolFn("skill_execute", {
      tool: "some_random_tool",
      input: { foo: "bar" },
    });

    // Non-browser tools should always go through the normal executor path
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0].name).toBe("some_random_tool");
    expect(executeBrowserOperationCalls).toHaveLength(0);
    expect(result.isError).toBe(true);
  });

  test("non-skill_execute calls are unaffected by browser bridge", async () => {
    registeredToolNames = new Set<string>();
    executeBrowserOperationCalls = [];

    const ctx = makeCtx();
    const { executor, getCalls } = makeCapturingExecutor({
      content: "direct result",
      isError: false,
    });

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    const result = await toolFn("file_read", { path: "README.md" });

    // Direct tool calls should go straight to executor
    expect(getCalls()).toHaveLength(1);
    expect(getCalls()[0].name).toBe("file_read");
    expect(executeBrowserOperationCalls).toHaveLength(0);
    expect(result.content).toBe("direct result");
  });

  test("skill_execute with empty tool name returns error regardless of browser bridge", async () => {
    registeredToolNames = new Set<string>();
    executeBrowserOperationCalls = [];

    const ctx = makeCtx();
    const { executor, getCalls } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    const result = await toolFn("skill_execute", {
      tool: "",
      input: {},
    });

    expect(result.isError).toBe(true);
    expect(result.content).toContain("skill_execute requires");
    expect(getCalls()).toHaveLength(0);
    expect(executeBrowserOperationCalls).toHaveLength(0);
  });

  test("legacy browser bridge propagates activity from outer input", async () => {
    registeredToolNames = new Set<string>();
    executeBrowserOperationCalls = [];
    executeBrowserOperationResult = {
      content: "Navigated",
      isError: false,
    };

    const ctx = makeCtx();
    const { executor } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    await toolFn("skill_execute", {
      tool: "browser_navigate",
      input: { url: "https://example.com" },
      activity: "Navigating to example.com",
    });

    // The bridge should have propagated the activity into the tool input
    expect(executeBrowserOperationCalls).toHaveLength(1);
    expect(executeBrowserOperationCalls[0].input.activity).toBe(
      "Navigating to example.com",
    );
  });
});
