/**
 * Tests for the background_tool_control tool.
 *
 * Verifies:
 * - "cancel" action calls BackgroundToolManager.cancel() and returns confirmation
 * - "wait" with no wait_seconds returns immediate status
 * - "wait" with short duration blocks and returns result on completion
 * - "wait" with short duration blocks and returns "still running" on timeout
 * - "wait" with long duration (> threshold) returns immediately with scheduleCheckIn
 * - Unknown execution_id returns error
 * - Tool is not registered when `tool-deferral` flag is disabled
 * - Tool is registered when `tool-deferral` flag is enabled
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { backgroundToolManager } from "../agent/background-tool-manager.js";
import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";
import { backgroundToolControlTool } from "../tools/background-tool-control.js";
import { getToolDeferralToolsIfEnabled } from "../tools/tool-manifest.js";
import type { ToolContext } from "../tools/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workingDir: "/tmp/test",
    conversationId: "conv-test-123",
    trustClass: "guardian",
    ...overrides,
  };
}

/**
 * Register a fake background execution for testing.
 */
function registerFakeExecution(
  executionId: string,
  opts: {
    resolve?: (result: { content: string; isError: boolean }) => void;
    reject?: (err: Error) => void;
    resolveWith?: { content: string; isError: boolean };
  } = {},
): {
  resolve: (result: { content: string; isError: boolean }) => void;
  reject: (err: Error) => void;
} {
  let resolvePromise!: (result: { content: string; isError: boolean }) => void;
  let rejectPromise!: (err: Error) => void;

  const promise = new Promise<{ content: string; isError: boolean }>(
    (resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    },
  );

  backgroundToolManager.register({
    executionId,
    toolName: "test_tool",
    toolUseId: "tu-123",
    conversationId: "conv-test-123",
    startedAt: Date.now(),
    promise,
  });

  if (opts.resolveWith) {
    resolvePromise(opts.resolveWith);
  }

  return { resolve: resolvePromise, reject: rejectPromise };
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  _setOverridesForTesting({});
  backgroundToolManager.cleanup("conv-test-123");
});

afterEach(() => {
  _setOverridesForTesting({});
  backgroundToolManager.cleanup("conv-test-123");
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("background_tool_control", () => {
  describe("tool properties", () => {
    test("has correct name and category", () => {
      expect(backgroundToolControlTool.name).toBe("background_tool_control");
      expect(backgroundToolControlTool.category).toBe("system");
    });

    test("is deferralExempt", () => {
      expect(backgroundToolControlTool.deferralExempt).toBe(true);
    });

    test("definition has correct input schema", () => {
      const def = backgroundToolControlTool.getDefinition();
      expect(def.name).toBe("background_tool_control");
      const schema = def.input_schema as {
        required: string[];
        properties: Record<string, unknown>;
      };
      expect(schema.required).toContain("execution_id");
      expect(schema.required).toContain("action");
      expect(schema.properties).toHaveProperty("execution_id");
      expect(schema.properties).toHaveProperty("action");
      expect(schema.properties).toHaveProperty("wait_seconds");
    });
  });

  describe("cancel action", () => {
    test("returns confirmation and calls manager.cancel()", async () => {
      registerFakeExecution("exec-1");

      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-1", action: "cancel" },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("exec-1");
      expect(result.content).toContain("cancelled");

      // Verify the execution is actually cancelled
      const status = backgroundToolManager.getStatus("exec-1");
      expect(status?.status).toBe("cancelled");
    });

    test("returns error for unknown execution_id", async () => {
      const result = await backgroundToolControlTool.execute(
        { execution_id: "nonexistent", action: "cancel" },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("No execution found");
    });
  });

  describe("wait action", () => {
    test("with no wait_seconds returns immediate status", async () => {
      registerFakeExecution("exec-2");

      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-2", action: "wait" },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("exec-2");
      expect(result.content).toContain("running");
    });

    test("with wait_seconds=0 returns immediate status", async () => {
      registerFakeExecution("exec-2b");

      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-2b", action: "wait", wait_seconds: 0 },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("exec-2b");
      expect(result.content).toContain("running");
    });

    test("immediate status for completed execution returns result", async () => {
      const { resolve } = registerFakeExecution("exec-2c");
      resolve({ content: "Tool output here", isError: false });
      // Allow microtask to settle
      await new Promise((r) => setTimeout(r, 10));

      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-2c", action: "wait" },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("completed");
      expect(result.content).toContain("Tool output here");
    });

    test("with short duration blocks and returns result on completion", async () => {
      // Default threshold is 10s; use wait_seconds=2 which is <= threshold
      const { resolve } = registerFakeExecution("exec-3");

      // Resolve after a short delay
      setTimeout(() => {
        resolve({ content: "Done!", isError: false });
      }, 50);

      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-3", action: "wait", wait_seconds: 2 },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("completed");
      expect(result.content).toContain("Done!");
    });

    test("with short duration blocks and returns 'still running' on timeout", async () => {
      // Register an execution that won't complete
      registerFakeExecution("exec-4");

      // Use a very short wait so the test doesn't block
      // Override config to have threshold of 5s so that 1s is "short"
      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-4", action: "wait", wait_seconds: 1 },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("still running");
    });

    test("with long duration (> threshold) returns immediately with scheduleCheckIn", async () => {
      // Default threshold is 10s; use wait_seconds=30 which is > threshold
      registerFakeExecution("exec-5");

      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-5", action: "wait", wait_seconds: 30 },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Deferred check-in scheduled");
      expect(result.scheduleCheckIn).toBeDefined();
      expect(result.scheduleCheckIn?.afterSeconds).toBe(30);
      expect(result.scheduleCheckIn?.executionId).toBe("exec-5");
      expect(result.scheduleCheckIn?.conversationId).toBe("conv-test-123");
    });

    test("returns error for unknown execution_id", async () => {
      const result = await backgroundToolControlTool.execute(
        { execution_id: "nonexistent", action: "wait" },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("No execution found");
    });
  });

  describe("unknown action", () => {
    test("returns error for invalid action", async () => {
      registerFakeExecution("exec-x");

      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-x", action: "restart" },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("Unknown action");
    });
  });

  describe("conversation ownership", () => {
    test("returns error when execution belongs to a different conversation", async () => {
      // Register under a different conversation
      backgroundToolManager.register({
        executionId: "exec-other-conv",
        toolName: "test_tool",
        toolUseId: "tu-other",
        conversationId: "conv-different",
        startedAt: Date.now(),
        promise: new Promise(() => {}),
      });

      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-other-conv", action: "wait" },
        makeContext(), // uses conversationId "conv-test-123"
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("does not belong to this conversation");

      // Cleanup the other conversation's entry
      backgroundToolManager.cleanup("conv-different");
    });

    test("cancel returns error when execution belongs to a different conversation", async () => {
      backgroundToolManager.register({
        executionId: "exec-other-cancel",
        toolName: "test_tool",
        toolUseId: "tu-other-cancel",
        conversationId: "conv-different",
        startedAt: Date.now(),
        promise: new Promise(() => {}),
      });

      const result = await backgroundToolControlTool.execute(
        { execution_id: "exec-other-cancel", action: "cancel" },
        makeContext(),
      );

      expect(result.isError).toBe(true);
      expect(result.content).toContain("does not belong to this conversation");

      backgroundToolManager.cleanup("conv-different");
    });
  });

  describe("terminal status before deferred check-in", () => {
    test("long wait on completed execution returns result immediately without scheduleCheckIn", async () => {
      const { resolve } = registerFakeExecution("exec-terminal-done");
      resolve({ content: "Already finished", isError: false });
      // Allow microtask to settle
      await new Promise((r) => setTimeout(r, 10));

      const result = await backgroundToolControlTool.execute(
        {
          execution_id: "exec-terminal-done",
          action: "wait",
          wait_seconds: 30,
        },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("completed");
      expect(result.content).toContain("Already finished");
      expect(result.scheduleCheckIn).toBeUndefined();
    });

    test("long wait on cancelled execution returns immediately without scheduleCheckIn", async () => {
      registerFakeExecution("exec-terminal-cancelled");
      backgroundToolManager.cancel("exec-terminal-cancelled");

      const result = await backgroundToolControlTool.execute(
        {
          execution_id: "exec-terminal-cancelled",
          action: "wait",
          wait_seconds: 30,
        },
        makeContext(),
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("cancelled");
      expect(result.scheduleCheckIn).toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// Feature flag gating
// ---------------------------------------------------------------------------

describe("tool-deferral feature flag gating", () => {
  test("tool is not registered when tool-deferral flag is disabled", () => {
    _setOverridesForTesting({ "tool-deferral": false });
    const tools = getToolDeferralToolsIfEnabled();
    expect(tools).toHaveLength(0);
  });

  test("tool is registered when tool-deferral flag is enabled", () => {
    _setOverridesForTesting({ "tool-deferral": true });
    const tools = getToolDeferralToolsIfEnabled();
    expect(tools).toHaveLength(1);
    expect(tools[0].name).toBe("background_tool_control");
  });
});
