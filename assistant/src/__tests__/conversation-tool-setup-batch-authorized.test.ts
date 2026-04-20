/**
 * Tests that createToolExecutor computes `batchAuthorizedByTask` against the
 * *dispatched* tool name, not the outer `skill_execute` wrapper. Task rules in
 * required_tools contain underlying tool names (e.g. "gmail_archive"), so a
 * regression here would silently break batch authorization for every
 * skill-dispatched batch tool (gmail_archive, gmail_unsubscribe,
 * messaging_archive_by_sender).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import type { ToolSetupContext } from "../daemon/conversation-tool-setup.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import {
  buildTaskRules,
  clearTaskRunRules,
  setTaskRunRules,
} from "../tasks/ephemeral-permissions.js";
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
    conversationId: "conv-batch-auth",
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
  let captured: { name: string; ctx: ToolContext } | undefined;
  return {
    executor: {
      execute: mock(
        async (
          name: string,
          _input: Record<string, unknown>,
          ctx: ToolContext,
        ) => {
          captured = { name, ctx };
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

describe("createToolExecutor — batchAuthorizedByTask for skill_execute dispatch", () => {
  const taskRunId = "task-run-skill-dispatch";

  afterEach(() => {
    clearTaskRunRules(taskRunId);
  });

  test("sets batchAuthorizedByTask=true when dispatched tool is in required_tools", async () => {
    setTaskRunRules(
      taskRunId,
      buildTaskRules(taskRunId, ["gmail_archive"], "/tmp"),
    );

    const ctx = makeCtx({ taskRunId });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    await toolFn("skill_execute", {
      tool: "gmail_archive",
      input: { message_ids: ["m1", "m2"] },
    });

    const captured = getCaptured();
    expect(captured).toBeDefined();
    expect(captured!.name).toBe("gmail_archive");
    expect(captured!.ctx.batchAuthorizedByTask).toBe(true);
  });

  test("sets batchAuthorizedByTask=false when dispatched tool is NOT in required_tools", async () => {
    // Task allows host_bash but not gmail_archive.
    setTaskRunRules(
      taskRunId,
      buildTaskRules(taskRunId, ["host_bash"], "/tmp"),
    );

    const ctx = makeCtx({ taskRunId });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    await toolFn("skill_execute", {
      tool: "gmail_archive",
      input: { message_ids: ["m1", "m2"] },
    });

    const captured = getCaptured();
    expect(captured).toBeDefined();
    expect(captured!.ctx.batchAuthorizedByTask).toBe(false);
  });

  test("does not get fooled by 'skill_execute' appearing in required_tools", async () => {
    // Regression guard: if the outer name were used, this malformed task
    // would accidentally authorize arbitrary batch tools.
    setTaskRunRules(
      taskRunId,
      buildTaskRules(taskRunId, ["skill_execute"], "/tmp"),
    );

    const ctx = makeCtx({ taskRunId });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    await toolFn("skill_execute", {
      tool: "gmail_archive",
      input: { message_ids: ["m1", "m2"] },
    });

    expect(getCaptured()!.ctx.batchAuthorizedByTask).toBe(false);
  });

  test("regular (non-skill_execute) dispatch still consults required_tools by outer name", async () => {
    setTaskRunRules(
      taskRunId,
      buildTaskRules(taskRunId, ["host_bash"], "/tmp"),
    );

    const ctx = makeCtx({ taskRunId });
    const { executor, getCaptured } = makeCapturingExecutor();

    const toolFn = createToolExecutor(
      executor as unknown as ToolExecutor,
      noopPrompter,
      noopSecretPrompter,
      ctx,
      noopLifecycleHandler,
    );

    await toolFn("host_bash", { command: "ls" });

    expect(getCaptured()!.ctx.batchAuthorizedByTask).toBe(true);
  });
});
