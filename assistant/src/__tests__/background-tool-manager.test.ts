import { describe, expect, test } from "bun:test";

import type { BackgroundExecution } from "../agent/background-tool-manager.js";
import { BackgroundToolManager } from "../agent/background-tool-manager.js";
import type { ToolExecutionResult } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeResult(content: string): ToolExecutionResult {
  return { content, isError: false };
}

/** Create a deferred promise that can be resolved/rejected externally. */
function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeExecution(
  overrides: Partial<Omit<BackgroundExecution, "status" | "result">> & {
    promise: Promise<ToolExecutionResult>;
  },
): Omit<BackgroundExecution, "status" | "result"> {
  return {
    executionId: overrides.executionId ?? "exec-1",
    toolName: overrides.toolName ?? "test_tool",
    toolUseId: overrides.toolUseId ?? "tu-1",
    conversationId: overrides.conversationId ?? "conv-1",
    startedAt: overrides.startedAt ?? Date.now(),
    promise: overrides.promise,
    abortController: overrides.abortController,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BackgroundToolManager", () => {
  test("register + getStatus returns 'running' for an unresolved promise", () => {
    const mgr = new BackgroundToolManager();
    const { promise } = deferred<ToolExecutionResult>();
    mgr.register(makeExecution({ promise }));

    const status = mgr.getStatus("exec-1");
    expect(status).not.toBeNull();
    expect(status!.status).toBe("running");
    expect(status!.elapsedMs).toBeGreaterThanOrEqual(0);
    expect(status!.result).toBeUndefined();
  });

  test("resolving the promise transitions status to 'completed' with the result", async () => {
    const mgr = new BackgroundToolManager();
    const { promise, resolve } = deferred<ToolExecutionResult>();
    mgr.register(makeExecution({ promise }));

    const result = makeResult("done");
    resolve(result);

    // Allow microtask queue to flush so the .then handler runs
    await promise;

    const status = mgr.getStatus("exec-1");
    expect(status).not.toBeNull();
    expect(status!.status).toBe("completed");
    expect(status!.result).toEqual(result);
  });

  test("waitFor with a promise that resolves within timeout returns completed: true", async () => {
    const mgr = new BackgroundToolManager();
    const { promise, resolve } = deferred<ToolExecutionResult>();
    mgr.register(makeExecution({ promise }));

    const result = makeResult("quick result");

    // Resolve after a short delay (well within the timeout)
    setTimeout(() => resolve(result), 10);

    const outcome = await mgr.waitFor("exec-1", 5000);
    expect(outcome.completed).toBe(true);
    expect(outcome.result).toEqual(result);
  });

  test("waitFor with a promise that does not resolve within timeout returns completed: false", async () => {
    const mgr = new BackgroundToolManager();
    const { promise } = deferred<ToolExecutionResult>();
    mgr.register(makeExecution({ promise }));

    const outcome = await mgr.waitFor("exec-1", 50);
    expect(outcome.completed).toBe(false);
  });

  test("waitFor with unknown executionId returns completed: false", async () => {
    const mgr = new BackgroundToolManager();
    const outcome = await mgr.waitFor("nonexistent", 100);
    expect(outcome.completed).toBe(false);
  });

  test("cancel sets status to 'cancelled' and fires the abort controller", () => {
    const mgr = new BackgroundToolManager();
    const { promise } = deferred<ToolExecutionResult>();
    const abortController = new AbortController();

    mgr.register(makeExecution({ promise, abortController }));

    expect(abortController.signal.aborted).toBe(false);

    const cancelResult = mgr.cancel("exec-1");
    expect(cancelResult.cancelled).toBe(true);
    expect(cancelResult.message).toContain("cancelled");
    expect(abortController.signal.aborted).toBe(true);

    const status = mgr.getStatus("exec-1");
    expect(status!.status).toBe("cancelled");
  });

  test("cancel returns false for already-completed executions", async () => {
    const mgr = new BackgroundToolManager();
    const { promise, resolve } = deferred<ToolExecutionResult>();
    mgr.register(makeExecution({ promise }));

    resolve(makeResult("done"));
    await promise;

    const cancelResult = mgr.cancel("exec-1");
    expect(cancelResult.cancelled).toBe(false);
    expect(cancelResult.message).toContain("already completed");
  });

  test("cancel returns false for unknown executionId", () => {
    const mgr = new BackgroundToolManager();
    const cancelResult = mgr.cancel("nonexistent");
    expect(cancelResult.cancelled).toBe(false);
    expect(cancelResult.message).toContain("No execution found");
  });

  test("drainCompleted returns completed entries and removes them, leaving running ones", async () => {
    const mgr = new BackgroundToolManager();

    // Execution 1: will complete
    const d1 = deferred<ToolExecutionResult>();
    mgr.register(
      makeExecution({
        executionId: "exec-1",
        conversationId: "conv-1",
        promise: d1.promise,
      }),
    );

    // Execution 2: will stay running
    const d2 = deferred<ToolExecutionResult>();
    mgr.register(
      makeExecution({
        executionId: "exec-2",
        conversationId: "conv-1",
        promise: d2.promise,
      }),
    );

    // Execution 3: completed but different conversation
    const d3 = deferred<ToolExecutionResult>();
    mgr.register(
      makeExecution({
        executionId: "exec-3",
        conversationId: "conv-2",
        promise: d3.promise,
      }),
    );

    const result1 = makeResult("result-1");
    d1.resolve(result1);
    await d1.promise;

    const result3 = makeResult("result-3");
    d3.resolve(result3);
    await d3.promise;

    // Drain conv-1 — should get exec-1, not exec-2 (running) or exec-3 (different conv)
    const drained = mgr.drainCompleted("conv-1");
    expect(drained).toHaveLength(1);
    expect(drained[0].executionId).toBe("exec-1");
    expect(drained[0].result).toEqual(result1);

    // Second drain is idempotent — returns empty
    const drainedAgain = mgr.drainCompleted("conv-1");
    expect(drainedAgain).toHaveLength(0);

    // exec-2 should still be tracked
    expect(mgr.getActiveCount("conv-1")).toBe(1);

    // exec-3 should still be in conv-2
    const drainedConv2 = mgr.drainCompleted("conv-2");
    expect(drainedConv2).toHaveLength(1);
    expect(drainedConv2[0].executionId).toBe("exec-3");
  });

  test("getActiveCount returns count of running executions for a conversation", () => {
    const mgr = new BackgroundToolManager();

    const d1 = deferred<ToolExecutionResult>();
    mgr.register(
      makeExecution({
        executionId: "exec-1",
        conversationId: "conv-1",
        promise: d1.promise,
      }),
    );

    const d2 = deferred<ToolExecutionResult>();
    mgr.register(
      makeExecution({
        executionId: "exec-2",
        conversationId: "conv-1",
        promise: d2.promise,
      }),
    );

    const d3 = deferred<ToolExecutionResult>();
    mgr.register(
      makeExecution({
        executionId: "exec-3",
        conversationId: "conv-2",
        promise: d3.promise,
      }),
    );

    expect(mgr.getActiveCount("conv-1")).toBe(2);
    expect(mgr.getActiveCount("conv-2")).toBe(1);
    expect(mgr.getActiveCount("conv-unknown")).toBe(0);
  });

  test("cleanup removes all entries for a conversation", () => {
    const mgr = new BackgroundToolManager();

    const d1 = deferred<ToolExecutionResult>();
    mgr.register(
      makeExecution({
        executionId: "exec-1",
        conversationId: "conv-1",
        promise: d1.promise,
      }),
    );

    const d2 = deferred<ToolExecutionResult>();
    mgr.register(
      makeExecution({
        executionId: "exec-2",
        conversationId: "conv-1",
        promise: d2.promise,
      }),
    );

    const d3 = deferred<ToolExecutionResult>();
    mgr.register(
      makeExecution({
        executionId: "exec-3",
        conversationId: "conv-2",
        promise: d3.promise,
      }),
    );

    mgr.cleanup("conv-1");

    // conv-1 entries should be gone
    expect(mgr.getStatus("exec-1")).toBeNull();
    expect(mgr.getStatus("exec-2")).toBeNull();
    expect(mgr.getActiveCount("conv-1")).toBe(0);

    // conv-2 should be unaffected
    expect(mgr.getStatus("exec-3")).not.toBeNull();
    expect(mgr.getActiveCount("conv-2")).toBe(1);
  });

  test("rejected promise transitions to completed with error result", async () => {
    const mgr = new BackgroundToolManager();
    const { promise, reject } = deferred<ToolExecutionResult>();
    mgr.register(makeExecution({ promise }));

    reject(new Error("tool exploded"));

    // Allow microtask queue to flush
    try {
      await promise;
    } catch {
      // expected
    }

    const status = mgr.getStatus("exec-1");
    expect(status).not.toBeNull();
    expect(status!.status).toBe("completed");
    expect(status!.result).toBeDefined();
    expect(status!.result!.isError).toBe(true);
    expect(status!.result!.content).toContain("tool exploded");
  });
});
