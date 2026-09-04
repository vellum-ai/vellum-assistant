/**
 * Tests for the activation turn hooks.
 *
 * The hooks are fire-and-forget, so the contract under test is: they
 * normalize what the agent loop hands them, they reach the store, and a
 * store failure never escapes as a rejection.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
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
        {
          path: join(workspaceDir, "notes", "plan.md"),
          filename: "Weekly plan.md",
          sourceType: "sandbox_file",
        },
        {
          path: join(workspaceDir, "notes", "summary.md"),
          filename: undefined,
          sourceType: "sandbox_file",
        },
        { path: "  ", filename: "ignored", sourceType: "sandbox_file" },
      ]),
    ).toEqual([
      { workspacePath: "notes/plan.md", displayName: "Weekly plan.md" },
      { workspacePath: "notes/summary.md", displayName: "summary.md" },
    ]);
  });

  test("stores a workspace file relative to the workspace", () => {
    expect(
      collectActivationArtifacts([
        {
          path: join(workspaceDir, "notes", "plan.md"),
          filename: undefined,
          sourceType: "sandbox_file",
        },
      ]),
    ).toEqual([{ workspacePath: "notes/plan.md", displayName: "plan.md" }]);
  });

  test("drops a host file, whose path names the user's machine", () => {
    expect(
      collectActivationArtifacts([
        {
          path: join(homedir(), "Documents", "taxes.pdf"),
          filename: "taxes.pdf",
          sourceType: "host_file",
        },
        // Dropped on its source type alone: a host read that happens to
        // land on a path shaped like a workspace one is still a host file.
        {
          path: join(workspaceDir, "notes", "taxes.pdf"),
          filename: "taxes.pdf",
          sourceType: "host_file",
        },
      ]),
    ).toEqual([]);
  });

  test("drops a path that escapes the workspace", () => {
    expect(
      collectActivationArtifacts([
        {
          path: join(workspaceDir, "..", "elsewhere", "secret.md"),
          filename: undefined,
          sourceType: "sandbox_file",
        },
        { path: workspaceDir, filename: undefined, sourceType: "sandbox_file" },
      ]),
    ).toEqual([]);
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
      endedAwaitingUser: false,
      attachedFiles: [
        {
          path: join(workspaceDir, "notes", "plan.md"),
          filename: undefined,
          sourceType: "sandbox_file",
        },
      ],
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
      endedAwaitingUser: false,
      attachedFiles: [],
    });
    await Bun.sleep(10);
    expect(readActivationProgress().tasks).toEqual({});
  });

  test("a turn that ended waiting on the user leaves the task running", async () => {
    await startActivationTask({
      taskId: "draft-email",
      conversationId: "conv-1",
    });

    onActivationTurnComplete({
      conversationId: "conv-1",
      toolCallCount: 1,
      endedAwaitingUser: true,
      attachedFiles: [],
    });
    await Bun.sleep(10);

    expect(readActivationProgress().tasks["draft-email"].status).toBe(
      "started",
    );
  });

  test("a second terminal turn changes nothing", async () => {
    await startActivationTask({
      taskId: "draft-email",
      conversationId: "conv-1",
    });
    await markActivationTurnComplete({
      conversationId: "conv-1",
      toolCallCount: 2,
      endedAwaitingUser: false,
      artifacts: [],
    });
    const done = readActivationProgress().tasks["draft-email"];

    onActivationTurnComplete({
      conversationId: "conv-1",
      toolCallCount: 7,
      endedAwaitingUser: false,
      attachedFiles: [
        {
          path: join(workspaceDir, "notes", "other.md"),
          filename: undefined,
          sourceType: "sandbox_file",
        },
      ],
    });
    await Bun.sleep(10);

    expect(readActivationProgress().tasks["draft-email"]).toEqual(done);
  });
});
