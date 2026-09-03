/**
 * Tests for the activation progress store.
 *
 * Covers the on-disk round trip, degraded reads, every transition's
 * idempotence and freeze rules, and the step-bump throttle (including its
 * trailing flush).
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// Capture invalidations without standing up SSE infrastructure. Mocking the
// publisher (one exported function) rather than the event hub keeps the mock
// harmless for any sibling file bun runs in the same process.
const publishedTags: string[][] = [];

mock.module("../runtime/sync/sync-publisher.js", () => ({
  publishSyncInvalidation: async (tags: string[]) => {
    publishedTags.push(tags);
    return { type: "sync_changed", tags };
  },
}));

const {
  ACTIVATION_PROGRESS_FILENAME,
  bumpActivationStepCount,
  dismissActivation,
  getActivationProgressPath,
  markActivationTurnComplete,
  readActivationProgress,
  resetActivationStepThrottleForTesting,
  startActivationTask,
} = await import("./progress-store.js");

const THROTTLE_MS = 40;

let workspaceDir: string;
let origWorkspaceDir: string | undefined;

beforeEach(() => {
  workspaceDir = mkdtempSync(join(tmpdir(), "vellum-activation-"));
  origWorkspaceDir = process.env.VELLUM_WORKSPACE_DIR;
  process.env.VELLUM_WORKSPACE_DIR = workspaceDir;
  publishedTags.length = 0;
  resetActivationStepThrottleForTesting(THROTTLE_MS);
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

function writeRawProgress(contents: string): void {
  mkdirSync(join(workspaceDir, "data"), { recursive: true });
  writeFileSync(getActivationProgressPath(), contents, "utf-8");
}

function syncPublishCount(): number {
  return publishedTags.filter((tags) => tags.includes("activation:progress"))
    .length;
}

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

describe("activation progress store", () => {
  describe("readActivationProgress", () => {
    test("resolves under <workspace>/data", () => {
      expect(getActivationProgressPath()).toBe(
        join(workspaceDir, "data", ACTIVATION_PROGRESS_FILENAME),
      );
    });

    test("missing file reads as the empty default", () => {
      expect(readActivationProgress()).toEqual({
        version: 1,
        listId: null,
        modalDismissedAt: null,
        allDoneShownAt: null,
        tasks: {},
      });
    });

    test("corrupt file reads as the empty default", () => {
      writeRawProgress("{ not json");
      expect(readActivationProgress().tasks).toEqual({});
    });

    test("schema-invalid file reads as the empty default", () => {
      writeRawProgress(JSON.stringify({ version: 99, tasks: "nope" }));
      expect(readActivationProgress().tasks).toEqual({});
    });
  });

  describe("startActivationTask", () => {
    test("persists the link and publishes an invalidation", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
        listId: "smb",
      });

      const stored = readActivationProgress();
      expect(stored.listId).toBe("smb");
      expect(stored.tasks["draft-email"]).toMatchObject({
        status: "started",
        conversationId: "conv-1",
        completedAt: null,
        stepCount: 0,
        artifacts: [],
      });
      expect(syncPublishCount()).toBe(1);
    });

    test("is idempotent for the same conversation", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      const first = readActivationProgress().tasks["draft-email"].startedAt;
      publishedTags.length = 0;

      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });

      expect(readActivationProgress().tasks["draft-email"].startedAt).toBe(
        first,
      );
      expect(syncPublishCount()).toBe(0);
    });

    test("a different conversation replaces the link while not done", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-2",
      });

      expect(readActivationProgress().tasks["draft-email"]).toMatchObject({
        conversationId: "conv-2",
        stepCount: 0,
      });
    });

    test("a done task keeps its conversation link", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 2,
        artifacts: [],
      });
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-2",
      });

      expect(readActivationProgress().tasks["draft-email"]).toMatchObject({
        status: "done",
        conversationId: "conv-1",
      });
    });

    test("listId freezes on the first write", async () => {
      await startActivationTask({
        taskId: "task-a",
        conversationId: "conv-1",
        listId: "smb",
      });
      await startActivationTask({
        taskId: "task-b",
        conversationId: "conv-2",
        listId: "parent",
      });

      expect(readActivationProgress().listId).toBe("smb");
    });

    test("rejects malformed ids", async () => {
      await expect(
        startActivationTask({ taskId: "Bad Id", conversationId: "conv-1" }),
      ).rejects.toThrow(/Invalid taskId/);
      await expect(
        startActivationTask({
          taskId: "task-a",
          conversationId: "conv-1",
          listId: "SMB",
        }),
      ).rejects.toThrow(/Invalid listId/);
      await expect(
        startActivationTask({ taskId: "task-a", conversationId: "  " }),
      ).rejects.toThrow(/conversationId is required/);
      expect(readActivationProgress().tasks).toEqual({});
    });
  });

  describe("dismissActivation", () => {
    test("records both kinds and keeps the first timestamp", async () => {
      await dismissActivation({ kind: "modal", listId: "general" });
      const stored = readActivationProgress();
      expect(stored.modalDismissedAt).not.toBeNull();
      expect(stored.allDoneShownAt).toBeNull();
      expect(stored.listId).toBe("general");

      await dismissActivation({ kind: "all-done" });
      const after = readActivationProgress();
      expect(after.allDoneShownAt).not.toBeNull();
      expect(after.modalDismissedAt).toBe(stored.modalDismissedAt);

      // The second dismiss of the same kind changes nothing.
      publishedTags.length = 0;
      await dismissActivation({ kind: "modal" });
      expect(syncPublishCount()).toBe(0);
    });

    test("does not thaw a frozen listId", async () => {
      await dismissActivation({ kind: "modal", listId: "smb" });
      await dismissActivation({ kind: "all-done", listId: "parent" });
      expect(readActivationProgress().listId).toBe("smb");
    });
  });

  describe("bumpActivationStepCount", () => {
    test("is a no-op for an unlinked conversation", async () => {
      await bumpActivationStepCount("conv-unlinked");
      expect(readActivationProgress().tasks).toEqual({});
      expect(syncPublishCount()).toBe(0);
    });

    test("throttles a burst and flushes the trailing count", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      publishedTags.length = 0;

      for (let i = 0; i < 5; i++) {
        await bumpActivationStepCount("conv-1");
      }

      // The leading bump lands immediately; the rest coalesce behind the
      // throttle window.
      expect(readActivationProgress().tasks["draft-email"].stepCount).toBe(1);
      expect(syncPublishCount()).toBe(1);

      await waitFor(
        () => readActivationProgress().tasks["draft-email"].stepCount === 5,
      );
      expect(syncPublishCount()).toBe(2);
    });
  });

  describe("markActivationTurnComplete", () => {
    test("is a no-op for an unlinked conversation", async () => {
      await markActivationTurnComplete({
        conversationId: "conv-unlinked",
        toolCallCount: 3,
        artifacts: [{ workspacePath: "a.md", displayName: "a.md" }],
      });
      expect(readActivationProgress().tasks).toEqual({});
      expect(syncPublishCount()).toBe(0);
    });

    test("records the step count and artifacts, and is idempotent", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 4,
        artifacts: [
          { workspacePath: "notes/plan.md", displayName: "plan.md" },
          { workspacePath: "notes/plan.md", displayName: "duplicate" },
          { workspacePath: "", displayName: "blank" },
        ],
      });

      const done = readActivationProgress().tasks["draft-email"];
      expect(done.status).toBe("done");
      expect(done.completedAt).not.toBeNull();
      expect(done.stepCount).toBe(4);
      expect(done.artifacts).toEqual([
        { workspacePath: "notes/plan.md", displayName: "plan.md" },
      ]);

      publishedTags.length = 0;
      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 9,
        artifacts: [],
      });
      expect(readActivationProgress().tasks["draft-email"]).toEqual(done);
      expect(syncPublishCount()).toBe(0);
    });

    test("never lowers a step count the user already saw", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await bumpActivationStepCount("conv-1");
      await bumpActivationStepCount("conv-1");

      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 1,
        artifacts: [],
      });

      expect(readActivationProgress().tasks["draft-email"].stepCount).toBe(2);
    });
  });
});
