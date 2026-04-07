import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import {
  type BackgroundExecution,
  BackgroundToolManager,
} from "../agent/background-tool-manager.js";
import type { ScheduleCheckInCallback } from "../agent/loop.js";

// ---------------------------------------------------------------------------
// Module mocks — must precede imports that touch the mocked modules
// ---------------------------------------------------------------------------

let testBgManager: BackgroundToolManager;
mock.module("../agent/background-tool-manager.js", () => ({
  get backgroundToolManager() {
    return testBgManager;
  },
  BackgroundToolManager,
}));

// Logger — no-op
mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Builds a scheduleCheckInCallback that mirrors the implementation in
 * conversation-agent-loop.ts. This allows us to unit-test the callback
 * behaviour (timer scheduling, status checking, injection) without
 * standing up the full conversation + agent loop machinery.
 */
function buildCheckInCallback(opts: {
  abortSignal: AbortSignal;
  processing: () => boolean;
  checkInTimers: Set<ReturnType<typeof setTimeout>>;
  injectCheckInMessage: (content: string) => Promise<void>;
  bgManager: BackgroundToolManager;
}): ScheduleCheckInCallback {
  const {
    abortSignal,
    processing,
    checkInTimers,
    injectCheckInMessage,
    bgManager,
  } = opts;

  return (checkIn) => {
    const { afterSeconds, executionId } = checkIn;

    const handle = setTimeout(() => {
      checkInTimers.delete(handle);

      if (abortSignal.aborted) return;
      if (processing()) return;

      const status = bgManager.getStatus(executionId);
      if (!status) return;
      if (status.status === "completed" || status.status === "cancelled") {
        return;
      }

      const totalElapsedSec = Math.round(status.elapsedMs / 1000);
      const syntheticContent = `<system_notice>Scheduled check-in: background execution ${executionId} (tool: ${status.toolName}) is still running after ${totalElapsedSec}s. Use background_tool_control to wait longer or cancel it.</system_notice>`;

      injectCheckInMessage(syntheticContent).catch(() => {});
    }, afterSeconds * 1000);

    checkInTimers.add(handle);
  };
}

function registerBackgroundExecution(
  manager: BackgroundToolManager,
  overrides?: Partial<Omit<BackgroundExecution, "status" | "result">>,
): { resolve: (result: { content: string; isError: boolean }) => void } {
  let resolvePromise!: (result: { content: string; isError: boolean }) => void;
  const promise = new Promise<{ content: string; isError: boolean }>((res) => {
    resolvePromise = res;
  });

  manager.register({
    executionId: overrides?.executionId ?? "exec-1",
    toolName: overrides?.toolName ?? "slow_tool",
    toolUseId: overrides?.toolUseId ?? "tu-1",
    conversationId: overrides?.conversationId ?? "conv-1",
    startedAt: overrides?.startedAt ?? Date.now() - 15_000,
    promise,
    ...(overrides?.abortController
      ? { abortController: overrides.abortController }
      : {}),
  });

  return { resolve: resolvePromise };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("deferred check-in scheduling", () => {
  let abortController: AbortController;
  let isProcessing: boolean;
  let checkInTimers: Set<ReturnType<typeof setTimeout>>;
  let injectedMessages: string[];
  let callback: ScheduleCheckInCallback;

  beforeEach(() => {
    testBgManager = new BackgroundToolManager();
    abortController = new AbortController();
    isProcessing = false;
    checkInTimers = new Set();
    injectedMessages = [];

    callback = buildCheckInCallback({
      abortSignal: abortController.signal,
      processing: () => isProcessing,
      checkInTimers,
      injectCheckInMessage: async (content) => {
        injectedMessages.push(content);
      },
      bgManager: testBgManager,
    });
  });

  afterEach(() => {
    // Clean up any outstanding timers
    for (const handle of checkInTimers) {
      clearTimeout(handle);
    }
    checkInTimers.clear();
    testBgManager.cleanup("conv-1");
    testBgManager.cleanup("conv-2");
  });

  test("timer fires and injects synthetic message when tool is still running", async () => {
    registerBackgroundExecution(testBgManager, {
      executionId: "exec-1",
      toolName: "slow_tool",
      conversationId: "conv-1",
      startedAt: Date.now() - 15_000,
    });

    // Schedule a check-in with a very short delay for testing
    callback({
      afterSeconds: 0.01, // 10ms
      executionId: "exec-1",
      conversationId: "conv-1",
    });

    expect(checkInTimers.size).toBe(1);

    // Wait for the timer to fire
    await Bun.sleep(50);

    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0]).toContain("background execution exec-1");
    expect(injectedMessages[0]).toContain("still running after");
    expect(injectedMessages[0]).toContain("<system_notice>");
    expect(injectedMessages[0]).toContain("background_tool_control");

    // Timer handle should have been removed from the set
    expect(checkInTimers.size).toBe(0);
  });

  test("timer fires but tool already completed — no injection", async () => {
    const { resolve } = registerBackgroundExecution(testBgManager, {
      executionId: "exec-2",
      toolName: "fast_tool",
      conversationId: "conv-1",
      startedAt: Date.now() - 5_000,
    });

    // Schedule a check-in
    callback({
      afterSeconds: 0.01,
      executionId: "exec-2",
      conversationId: "conv-1",
    });

    // Complete the tool before the timer fires
    resolve({ content: "done", isError: false });
    // Allow the promise.then handler in register() to run
    await Bun.sleep(5);

    // Now wait for the timer to fire
    await Bun.sleep(50);

    // No injection because the tool completed
    expect(injectedMessages).toHaveLength(0);
    expect(checkInTimers.size).toBe(0);
  });

  test("conversation aborted before timer fires — timer is cleared, no injection", async () => {
    registerBackgroundExecution(testBgManager, {
      executionId: "exec-3",
      conversationId: "conv-1",
    });

    // Schedule a check-in with a longer delay
    callback({
      afterSeconds: 0.1, // 100ms
      executionId: "exec-3",
      conversationId: "conv-1",
    });

    expect(checkInTimers.size).toBe(1);

    // Abort before the timer fires
    abortController.abort();

    // Wait for the timer's scheduled time to pass
    await Bun.sleep(150);

    // No injection because the conversation was aborted
    expect(injectedMessages).toHaveLength(0);
  });

  test("multiple concurrent deferred check-ins for different tools", async () => {
    registerBackgroundExecution(testBgManager, {
      executionId: "exec-a",
      toolName: "tool_a",
      conversationId: "conv-1",
      startedAt: Date.now() - 10_000,
    });

    registerBackgroundExecution(testBgManager, {
      executionId: "exec-b",
      toolName: "tool_b",
      conversationId: "conv-1",
      startedAt: Date.now() - 20_000,
    });

    // Schedule two check-ins
    callback({
      afterSeconds: 0.01,
      executionId: "exec-a",
      conversationId: "conv-1",
    });

    callback({
      afterSeconds: 0.01,
      executionId: "exec-b",
      conversationId: "conv-1",
    });

    expect(checkInTimers.size).toBe(2);

    // Wait for both timers to fire
    await Bun.sleep(50);

    // Both should have injected messages
    expect(injectedMessages).toHaveLength(2);
    expect(injectedMessages.some((m) => m.includes("exec-a"))).toBe(true);
    expect(injectedMessages.some((m) => m.includes("exec-b"))).toBe(true);

    // All timer handles cleaned up
    expect(checkInTimers.size).toBe(0);
  });

  test("check-in skipped when conversation is processing another turn", async () => {
    registerBackgroundExecution(testBgManager, {
      executionId: "exec-4",
      conversationId: "conv-1",
    });

    callback({
      afterSeconds: 0.01,
      executionId: "exec-4",
      conversationId: "conv-1",
    });

    // Simulate the conversation already processing a new turn
    isProcessing = true;

    // Wait for the timer to fire
    await Bun.sleep(50);

    // No injection because the conversation is processing
    expect(injectedMessages).toHaveLength(0);
  });

  test("check-in skipped when execution not found (already drained)", async () => {
    // Don't register any execution — simulate it being already drained
    callback({
      afterSeconds: 0.01,
      executionId: "nonexistent",
      conversationId: "conv-1",
    });

    await Bun.sleep(50);

    expect(injectedMessages).toHaveLength(0);
  });
});
