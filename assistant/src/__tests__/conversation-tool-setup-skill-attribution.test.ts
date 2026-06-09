/**
 * Tests for skill attribution in the skill_execute interception of
 * createToolExecutor (conversation-tool-setup.ts): skill-routed dispatches
 * must carry the owning skill's id on the ToolContext handed to the
 * executor, while direct tool calls must not.
 */

import { afterAll, describe, expect, mock, test } from "bun:test";

import type { ToolSetupContext } from "../daemon/conversation-tool-setup.js";
import type { SurfaceData, SurfaceType } from "../daemon/message-protocol.js";
import type { PermissionPrompter } from "../permissions/prompter.js";
import type { SecretPrompter } from "../permissions/secret-prompter.js";
import { RiskLevel } from "../permissions/types.js";
import type { ToolExecutor } from "../tools/executor.js";
import type { Tool, ToolContext, ToolExecutionResult } from "../tools/types.js";

mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: mock(() => {}),
}));

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

mock.module("../memory/app-store.js", () => ({
  getApp: mock(() => null),
  getAppDirPath: mock(() => "/tmp/test-apps/dummy"),
  isMultifileApp: mock(() => false),
  getAppsDir: mock(() => "/tmp/test-apps"),
  resolveAppIdByDirName: mock(() => null),
  resolveAppIdFromPath: mock(() => null),
}));

import { createToolExecutor } from "../daemon/conversation-tool-setup.js";
import { registerSkillTools, unregisterSkillTools } from "../tools/registry.js";

const SKILL_ID = "attribution-test-skill";
const SKILL_TOOL_NAME = "attribution_test_tool";

const skillTool: Tool = {
  name: SKILL_TOOL_NAME,
  description: "skill tool for attribution tests",
  category: "skill",
  defaultRiskLevel: RiskLevel.Low,
  executionTarget: "sandbox",
  input_schema: { type: "object", properties: {} },
  execute: async () => ({ content: "ok", isError: false }),
};

registerSkillTools(SKILL_ID, [skillTool]);
afterAll(() => unregisterSkillTools(SKILL_ID));

function makeCtx(): ToolSetupContext {
  return {
    conversationId: "conv-test",
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
  };
}

/** Fake ToolExecutor that captures the context of each execute() call. */
function makeCapturingExecutor() {
  const calls: Array<{ name: string; context: ToolContext }> = [];
  const executor = {
    execute: async (
      name: string,
      _input: Record<string, unknown>,
      context: ToolContext,
    ): Promise<ToolExecutionResult> => {
      calls.push({ name, context });
      return { content: "ok", isError: false };
    },
  };
  return { executor: executor as unknown as ToolExecutor, calls };
}

const noopPrompter = {
  prompt: mock(async () => ({ decision: "allow" as const })),
} as unknown as PermissionPrompter;
const noopSecretPrompter = {
  prompt: mock(async () => ({ cancelled: true })),
} as unknown as SecretPrompter;

function makeToolFn(executor: ToolExecutor) {
  return createToolExecutor(
    executor,
    noopPrompter,
    noopSecretPrompter,
    makeCtx(),
    () => {},
  );
}

describe("conversation-tool-setup skill attribution", () => {
  test("skill_execute dispatch sets the owning skill id on the executor context", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(executor);

    const result = await toolFn("skill_execute", {
      tool: SKILL_TOOL_NAME,
      input: {},
      activity: "testing",
    });

    expect(result).toMatchObject({ content: "ok", isError: false });
    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe(SKILL_TOOL_NAME);
    expect(calls[0].context.skillId).toBe(SKILL_ID);
  });

  test("skill_execute with a non-skill-owned tool leaves skillId unset", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(executor);

    await toolFn("skill_execute", {
      tool: "file_read",
      input: { path: "/tmp/a" },
      activity: "testing",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("file_read");
    expect(calls[0].context.skillId).toBeUndefined();
  });

  test("direct tool calls leave skillId unset", async () => {
    const { executor, calls } = makeCapturingExecutor();
    const toolFn = makeToolFn(executor);

    await toolFn("file_read", { path: "/tmp/a" });

    expect(calls).toHaveLength(1);
    expect(calls[0].name).toBe("file_read");
    expect(calls[0].context.skillId).toBeUndefined();
  });
});
