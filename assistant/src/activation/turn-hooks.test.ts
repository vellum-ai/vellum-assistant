/**
 * Tests for the activation turn hooks.
 *
 * The hooks are fire-and-forget, so the contract under test is: they
 * normalize what the agent loop hands them, they reach the store, and a
 * store failure never escapes as a rejection.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Mocking the publisher (one exported function) rather than the event hub
// keeps the mock harmless for any sibling file bun runs in the same process.
mock.module("../runtime/sync/sync-publisher.js", () => ({
  publishSyncInvalidation: async (tags: string[]) => ({
    type: "sync_changed",
    tags,
  }),
}));

const {
  markActivationTurnComplete,
  readActivationProgress,
  resetActivationStepThrottleForTesting,
  startActivationTask,
} = await import("./progress-store.js");
const {
  collectActivationArtifacts,
  onActivationToolCall,
  onActivationTurnComplete,
} = await import("./turn-hooks.js");

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-activation-hooks-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  resetActivationStepThrottleForTesting(0);
});

afterEach(() => {
  resetActivationStepThrottleForTesting();
  if (origWorkspaceDir === undefined) {
    delete process.env.VELLUM_WORKSPACE_DIR;
  } else {
    process.env.VELLUM_WORKSPACE_DIR = origWorkspaceDir;
  }
  rmSync(workspaceDir, { recursive: true, force: true });
});

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (predicate()) {
      return;
    }
    await Bun.sleep(5);
  }
  throw new Error("Timed out waiting for condition");
}

describe("collectActivationArtifacts", () => {
  test("prefers the explicit filename and falls back to the basename", () => {
    expect(
      collectActivationArtifacts([
        { path: "notes/plan.md", filename: "Weekly plan.md" },
        { path: "notes/summary.md", filename: undefined },
        { path: "  ", filename: "ignored" },
      ]),
    ).toEqual([
      { workspacePath: "notes/plan.md", displayName: "Weekly plan.md" },
      { workspacePath: "notes/summary.md", displayName: "summary.md" },
    ]);
  });

  test("returns an empty list when the turn attached nothing", () => {
    expect(collectActivationArtifacts([])).toEqual([]);
  });
});

describe("onActivationToolCall", () => {
  test("moves the linked task's step count", async () => {
    await startActivationTask({
      taskId: "draft-email",
      conversationId: "conv-1",
    });

    onActivationToolCall("conv-1");

    await waitFor(
      () => readActivationProgress().tasks["draft-email"].stepCount === 1,
    );
  });

  test("does not throw for an unlinked conversation", async () => {
    expect(() => onActivationToolCall("conv-unlinked")).not.toThrow();
    await Bun.sleep(10);
    expect(readActivationProgress().tasks).toEqual({});
  });
});

describe("onActivationTurnComplete", () => {
  test("completes the linked task with normalized artifacts", async () => {
    await startActivationTask({
      taskId: "draft-email",
      conversationId: "conv-1",
    });

    onActivationTurnComplete({
      conversationId: "conv-1",
      toolCallCount: 3,
      attachedFiles: [{ path: "notes/plan.md", filename: undefined }],
    });

    await waitFor(
      () => readActivationProgress().tasks["draft-email"].status === "done",
    );
    expect(readActivationProgress().tasks["draft-email"]).toMatchObject({
      stepCount: 3,
      artifacts: [{ workspacePath: "notes/plan.md", displayName: "plan.md" }],
    });
  });

  test("is a no-op for a conversation no task points at", async () => {
    onActivationTurnComplete({
      conversationId: "conv-unlinked",
      toolCallCount: 2,
      attachedFiles: [],
    });
    await Bun.sleep(10);
    expect(readActivationProgress().tasks).toEqual({});
  });

  test("a second terminal turn changes nothing", async () => {
    await startActivationTask({
      taskId: "draft-email",
      conversationId: "conv-1",
    });
    await markActivationTurnComplete({
      conversationId: "conv-1",
      toolCallCount: 2,
      artifacts: [],
    });
    const done = readActivationProgress().tasks["draft-email"];

    onActivationTurnComplete({
      conversationId: "conv-1",
      toolCallCount: 7,
      attachedFiles: [{ path: "notes/other.md", filename: undefined }],
    });
    await Bun.sleep(10);

    expect(readActivationProgress().tasks["draft-email"]).toEqual(done);
  });
});
