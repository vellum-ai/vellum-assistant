/**
 * Tests that createToolExecutor propagates forcePromptSideEffects from the
 * session's memory policy (strictSideEffects) into the ToolContext.
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

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------

import { createToolExecutor } from "../daemon/conversation-tool-setup.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCtx(overrides: Partial<ToolSetupContext> = {}): ToolSetupContext {
  return {
    conversationId: "conv-side-effect",
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

/** Executor spy that captures the ToolContext passed to execute(). */
function makeCapturingExecutor(
  result: ToolExecutionResult = { content: "ok", isError: false },
) {
  let captured: ToolContext | undefined;
  return {
    executor: {
      execute: mock(
        async (
          _name: string,
          _input: Record<string, unknown>,
          ctx: ToolContext,
        ) => {
          captured = ctx;
          return result;
        },
      ),
    },
    getCaptured: () => captured,
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

describe("session-tool-setup forcePromptSideEffects propagation", () => {
  test("sets forcePromptSideEffects to false for default sessions", async () => {
    const ctx = makeCtx({
      memoryPolicy: { scopeId: "default", strictSideEffects: false },
    });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    await toolFn("some_tool", { key: "value" });

    expect(getCaptured()).toBeDefined();
    expect(getCaptured()!.forcePromptSideEffects).toBe(false);
  });

  test("sets forcePromptSideEffects to true for private sessions with strictSideEffects", async () => {
    const ctx = makeCtx({
      memoryPolicy: { scopeId: "private-thread-123", strictSideEffects: true },
    });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    await toolFn("memory_write", { content: "secret" });

    expect(getCaptured()!.forcePromptSideEffects).toBe(true);
  });

  test("reads forcePromptSideEffects at call time, not construction time", async () => {
    const ctx = makeCtx({
      memoryPolicy: { scopeId: "initial", strictSideEffects: false },
    });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    // Mutate the memory policy after construction
    ctx.memoryPolicy = { scopeId: "initial", strictSideEffects: true };

    await toolFn("some_tool", {});

    expect(getCaptured()!.forcePromptSideEffects).toBe(true);
  });
});
