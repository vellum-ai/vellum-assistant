/**
 * Tests for the activation progress store.
 *
 * Covers the on-disk round trip, degraded reads, every transition's
 * idempotence and freeze rules, and the step-bump throttle (including its
 * trailing flush).
 */

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as nodeFs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

/**
 * The real implementation, captured before any spy replaces it, so a stub
 * that wants the genuine bytes does not call itself.
 */
const realReadFileSync = nodeFs.readFileSync;

import type { ActivationProgress } from "../api/responses/activation.js";
import { _resetStreamStateForTesting } from "../runtime/assistant-stream-state.js";

// Capture invalidations without standing up SSE infrastructure. Mocking the
// publisher (one exported function) rather than the event hub keeps the mock
// harmless for any sibling file bun runs in the same process.
const publishedTags: string[][] = [];
const publishedOrigins: (string | undefined)[] = [];

mock.module("../runtime/sync/sync-publisher.js", () => ({
  publishSyncInvalidation: async (tags: string[], originClientId?: string) => {
    publishedTags.push(tags);
    publishedOrigins.push(originClientId);
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
  publishedOrigins.length = 0;
  // A sibling test file may have left this process pretending to be a
  // sidecar worker, which routes publishes to the daemon instead of the hub.
  _resetStreamStateForTesting();
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

/**
 * Make every write fail by occupying the data directory's path with a
 * regular file, so `mkdirSync` cannot create it.
 */
function breakDataDir(): void {
  writeFileSync(join(workspaceDir, "data"), "not a directory", "utf-8");
}

/**
 * Read the file directly, without going through the store, so an assertion
 * cannot warm the in-memory link index the test is measuring.
 */
function readRawProgress(): ActivationProgress {
  return JSON.parse(
    readFileSync(getActivationProgressPath(), "utf-8"),
  ) as ActivationProgress;
}

/** Rewrite the file behind the store's back. */
function writeProgressBehindStore(progress: ActivationProgress): void {
  writeRawProgress(JSON.stringify(progress, null, 2));
}

/** A `started` record, as a writer other than the store would leave one. */
function startedTask(conversationId: string) {
  return {
    status: "started" as const,
    conversationId,
    startedAt: new Date().toISOString(),
    completedAt: null,
    stepCount: 0,
    artifacts: [],
  };
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
        endedAwaitingUser: false,
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
        endedAwaitingUser: false,
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
        endedAwaitingUser: false,
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
        endedAwaitingUser: false,
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
        endedAwaitingUser: false,
        artifacts: [],
      });

      expect(readActivationProgress().tasks["draft-email"].stepCount).toBe(2);
    });
  });

  describe("linked-conversation index", () => {
    test.skipIf(process.getuid?.() === 0)(
      "an unchanged file is not re-read for an unlinked conversation",
      async () => {
        await startActivationTask({
          taskId: "draft-email",
          conversationId: "conv-1",
        });
        // The write leaves the index unstamped, so the first miss rereads
        // and stamps it. From there a miss is answered by a stat.
        await bumpActivationStepCount("conv-unlinked");

        // Unreadable but still stat-able, and neither size nor mtime moved:
        // a lookup that re-read here would degrade to empty progress and
        // lose the link the next bump depends on.
        chmodSync(getActivationProgressPath(), 0o000);
        await bumpActivationStepCount("conv-unlinked");
        chmodSync(getActivationProgressPath(), 0o600);

        await bumpActivationStepCount("conv-1");
        expect(readRawProgress().tasks["draft-email"].stepCount).toBe(1);
      },
    );

    test("a link another process wrote is picked up by the next bump", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      // Warm a negative entry for the conversation, the way a long-lived
      // schedule or memory worker does before the daemon links it.
      await bumpActivationStepCount("conv-2");

      const external = readRawProgress();
      external.tasks["book-travel"] = startedTask("conv-2");
      writeProgressBehindStore(external);

      await bumpActivationStepCount("conv-2");
      await markActivationTurnComplete({
        conversationId: "conv-2",
        toolCallCount: 3,
        endedAwaitingUser: false,
        artifacts: [],
      });

      expect(readRawProgress().tasks["book-travel"]).toMatchObject({
        status: "done",
        stepCount: 3,
      });
    });

    test("a link is visible to the very next bump", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });

      await bumpActivationStepCount("conv-1");

      expect(readRawProgress().tasks["draft-email"].stepCount).toBe(1);
    });

    test("a second start on the conversation moves the link", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await startActivationTask({
        taskId: "book-travel",
        conversationId: "conv-1",
      });

      await bumpActivationStepCount("conv-1");

      const tasks = readRawProgress().tasks;
      expect(tasks["draft-email"]).toBeUndefined();
      expect(tasks["book-travel"].stepCount).toBe(1);
    });

    test("completion drops the link", async () => {
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

      await bumpActivationStepCount("conv-1");

      // No `started` task points at the conversation any more, so the bump
      // has nothing to count against.
      expect(readRawProgress().tasks["draft-email"]).toMatchObject({
        status: "done",
        stepCount: 2,
      });
    });

    test("a write during a read is not stamped as already indexed", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      // Cold index, so the next lookup has to go to disk.
      resetActivationStepThrottleForTesting(THROTTLE_MS);

      const external = readRawProgress();
      external.tasks["book-travel"] = startedTask("conv-2");

      const spy = spyOn(nodeFs, "readFileSync");
      spy.mockImplementationOnce(((path: never, options: never) => {
        const raw = realReadFileSync(path, options);
        // Another process records the link while this read is in flight.
        writeProgressBehindStore(external);
        return raw;
      }) as typeof nodeFs.readFileSync);
      try {
        await bumpActivationStepCount("conv-unlinked");
      } finally {
        spy.mockRestore();
      }

      // The index holds the pre-write bytes. Stamping it after the read
      // would file them under the post-write stamp, and this link would
      // stay invisible for the life of the process.
      await bumpActivationStepCount("conv-2");

      expect(readRawProgress().tasks["book-travel"].stepCount).toBe(1);
    });

    test("a write leaves the stamp stale: one reread, then hits stay free", async () => {
      // A window wide enough that only the first bump per conversation
      // flushes, so a later bump exercises the lookup without a write.
      resetActivationStepThrottleForTesting(60_000);
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      // Flush the first bump, so the index is the one the write rebuilt.
      await bumpActivationStepCount("conv-1");

      const path = getActivationProgressPath();
      const readSpy = spyOn(nodeFs, "readFileSync");
      const statSpy = spyOn(nodeFs, "statSync");
      const callsFor = (spy: { mock: { calls: unknown[][] } }): number =>
        spy.mock.calls.filter((args) => args[0] === path).length;
      try {
        // A hit answers from the map, so it costs no syscall at all.
        await bumpActivationStepCount("conv-1");
        expect(callsFor(readSpy)).toBe(0);
        expect(callsFor(statSpy)).toBe(0);

        // The write could not tie a stamp to the bytes it landed, so the
        // first miss against that index rereads.
        await bumpActivationStepCount("conv-unlinked");
        expect(callsFor(readSpy)).toBe(1);

        // That reread stamped the index, so the next miss is one stat.
        const statsAfterReread = callsFor(statSpy);
        await bumpActivationStepCount("conv-unlinked");
        expect(callsFor(readSpy)).toBe(1);
        expect(callsFor(statSpy)).toBe(statsAfterReread + 1);
      } finally {
        readSpy.mockRestore();
        statSpy.mockRestore();
      }
    });

    test("the test-only reset drops the index", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      const external = readRawProgress();
      external.tasks["book-travel"] = startedTask("conv-2");
      writeProgressBehindStore(external);

      resetActivationStepThrottleForTesting(THROTTLE_MS);
      await bumpActivationStepCount("conv-2");

      expect(readRawProgress().tasks["book-travel"].stepCount).toBe(1);
    });
  });

  describe("origin client", () => {
    test("a write carries the client that made it", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
        originClientId: "client-a",
      });
      expect(publishedOrigins).toEqual(["client-a"]);

      publishedOrigins.length = 0;
      await dismissActivation({ kind: "modal", originClientId: "client-b" });
      expect(publishedOrigins).toEqual(["client-b"]);
    });

    test("a turn-driven write carries no client", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      publishedOrigins.length = 0;

      await bumpActivationStepCount("conv-1");

      expect(publishedOrigins).toEqual([undefined]);
    });
  });

  describe("a newer schema version on disk", () => {
    function writeNewerProgress(): void {
      writeRawProgress(
        JSON.stringify({
          version: 2,
          listId: "smb",
          modalDismissedAt: null,
          allDoneShownAt: null,
          somethingNew: { added: "in v2" },
          tasks: {
            "draft-email": startedTask("conv-1"),
            "book-travel": { status: "started", butMalformed: true },
          },
        }),
      );
    }

    test("reads the fields this build still understands", () => {
      writeNewerProgress();

      const stored = readActivationProgress();
      expect(stored.listId).toBe("smb");
      expect(stored.tasks["draft-email"]).toMatchObject({
        status: "started",
        conversationId: "conv-1",
      });
      // The record this build cannot parse is dropped, not guessed at.
      expect(stored.tasks["book-travel"]).toBeUndefined();
    });

    test("drops a task key this build would never have written", () => {
      writeRawProgress(
        JSON.stringify({
          version: 2,
          listId: null,
          modalDismissedAt: null,
          allDoneShownAt: null,
          tasks: {
            "draft-email": startedTask("conv-1"),
            [`x-${"y".repeat(200)}`]: startedTask("conv-2"),
            "Not A Task": startedTask("conv-3"),
          },
        }),
      );

      expect(Object.keys(readActivationProgress().tasks)).toEqual([
        "draft-email",
      ]);
    });

    test("drops a known field whose value does not validate", () => {
      writeRawProgress(
        JSON.stringify({
          version: 2,
          listId: 17,
          modalDismissedAt: { at: "yesterday" },
          allDoneShownAt: "2026-01-01T00:00:00.000Z",
          tasks: {},
        }),
      );

      const stored = readActivationProgress();
      expect(stored.listId).toBeNull();
      expect(stored.modalDismissedAt).toBeNull();
      expect(stored.allDoneShownAt).toBe("2026-01-01T00:00:00.000Z");
    });

    test("is never written back, so a rollback cannot erase it", async () => {
      writeNewerProgress();
      const before = readFileSync(getActivationProgressPath(), "utf-8");

      await expect(dismissActivation({ kind: "modal" })).rejects.toMatchObject({
        statusCode: 409,
      });
      await expect(
        startActivationTask({
          taskId: "book-travel",
          conversationId: "conv-2",
        }),
      ).rejects.toMatchObject({ statusCode: 409 });
      await expect(
        markActivationTurnComplete({
          conversationId: "conv-1",
          toolCallCount: 4,
          endedAwaitingUser: false,
          artifacts: [],
        }),
      ).rejects.toMatchObject({ statusCode: 409 });

      expect(readFileSync(getActivationProgressPath(), "utf-8")).toBe(before);
      expect(syncPublishCount()).toBe(0);
    });

    test("a refused step flush is not retried against a document it may not write", async () => {
      writeNewerProgress();

      await expect(bumpActivationStepCount("conv-1")).rejects.toMatchObject({
        statusCode: 409,
      });

      // Nothing is left armed to rewrite the newer document later.
      await Bun.sleep(THROTTLE_MS * 3);
      expect(syncPublishCount()).toBe(0);
    });
  });

  describe("what finishes a task", () => {
    test("a turn that answered in prose alone still finishes it", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });

      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 0,
        endedAwaitingUser: false,
        artifacts: [],
      });

      expect(readActivationProgress().tasks["draft-email"].status).toBe("done");
    });

    test("a turn that ended waiting on the user does not, and the next turn does", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });

      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 1,
        endedAwaitingUser: true,
        artifacts: [],
      });
      expect(readActivationProgress().tasks["draft-email"].status).toBe(
        "started",
      );

      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 2,
        endedAwaitingUser: false,
        artifacts: [],
      });
      expect(readActivationProgress().tasks["draft-email"]).toMatchObject({
        status: "done",
        stepCount: 2,
      });
    });

    test("a turn that ended waiting on the user still persists its step count", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await bumpActivationStepCount("conv-1");

      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 1,
        endedAwaitingUser: true,
        artifacts: [],
      });

      expect(readActivationProgress().tasks["draft-email"]).toMatchObject({
        status: "started",
        stepCount: 1,
      });
    });

    test("a turn that only attached a file still finishes the task", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });

      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 0,
        endedAwaitingUser: false,
        artifacts: [{ workspacePath: "notes/plan.md", displayName: "plan.md" }],
      });

      expect(readActivationProgress().tasks["draft-email"].status).toBe("done");
    });
  });

  describe("persistence failures", () => {
    test("a failed write rejects instead of reporting saved progress", async () => {
      breakDataDir();

      await expect(
        startActivationTask({
          taskId: "draft-email",
          conversationId: "conv-1",
        }),
      ).rejects.toThrow(/Failed to persist activation progress/);
      await expect(dismissActivation({ kind: "modal" })).rejects.toThrow(
        /Failed to persist activation progress/,
      );
      expect(syncPublishCount()).toBe(0);
    });

    test("a failed write leaves no temp file behind", async () => {
      // Occupy the destination with a directory, so the temp file is written
      // and only the rename fails.
      mkdirSync(getActivationProgressPath(), { recursive: true });

      await expect(
        startActivationTask({
          taskId: "draft-email",
          conversationId: "conv-1",
        }),
      ).rejects.toThrow(/Failed to persist activation progress/);

      expect(
        readdirSync(join(workspaceDir, "data")).filter((name) =>
          name.includes(".tmp."),
        ),
      ).toEqual([]);
    });

    test.skipIf(process.getuid?.() === 0)(
      "a failed step flush keeps the tool calls it was carrying",
      async () => {
        await startActivationTask({
          taskId: "draft-email",
          conversationId: "conv-1",
        });

        // Read-only data dir: the snapshot still reads, the temp file cannot
        // be created.
        chmodSync(join(workspaceDir, "data"), 0o500);
        await expect(bumpActivationStepCount("conv-1")).rejects.toThrow(
          /Failed to persist activation progress/,
        );
        chmodSync(join(workspaceDir, "data"), 0o700);

        await bumpActivationStepCount("conv-1");

        // Both the bump that failed to land and the one after it.
        await waitFor(
          () => readRawProgress().tasks["draft-email"].stepCount === 2,
        );
      },
    );

    test.skipIf(process.getuid?.() === 0)(
      "a failed step flush retries itself, with no later bump to drive it",
      async () => {
        await startActivationTask({
          taskId: "draft-email",
          conversationId: "conv-1",
        });

        chmodSync(join(workspaceDir, "data"), 0o500);
        await expect(bumpActivationStepCount("conv-1")).rejects.toThrow(
          /Failed to persist activation progress/,
        );
        chmodSync(join(workspaceDir, "data"), 0o700);

        // Nothing else touches the conversation: the armed retry is the only
        // thing left that can land the count.
        await waitFor(
          () => readRawProgress().tasks["draft-email"].stepCount === 1,
        );
      },
    );

    test.skipIf(process.getuid?.() === 0)(
      "a step flush that keeps failing gives up instead of retrying forever",
      async () => {
        await startActivationTask({
          taskId: "draft-email",
          conversationId: "conv-1",
        });

        chmodSync(join(workspaceDir, "data"), 0o500);
        await expect(bumpActivationStepCount("conv-1")).rejects.toThrow(
          /Failed to persist activation progress/,
        );
        // Long enough for every attempt the bound allows.
        await Bun.sleep(THROTTLE_MS * 10);
        chmodSync(join(workspaceDir, "data"), 0o700);
        await Bun.sleep(THROTTLE_MS * 4);

        expect(readRawProgress().tasks["draft-email"].stepCount).toBe(0);
      },
    );

    test("a failed step flush still lets the turn complete", async () => {
      // A window wide enough that the second bump is certain to be pending
      // when the completion flushes it.
      resetActivationStepThrottleForTesting(5_000);
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await bumpActivationStepCount("conv-1");
      await bumpActivationStepCount("conv-1");

      const spy = spyOn(nodeFs, "writeFileSync");
      spy.mockImplementationOnce(() => {
        throw new Error("transient write failure");
      });
      try {
        await markActivationTurnComplete({
          conversationId: "conv-1",
          toolCallCount: 4,
          endedAwaitingUser: false,
          artifacts: [],
        });
      } finally {
        spy.mockRestore();
      }

      expect(readRawProgress().tasks["draft-email"]).toMatchObject({
        status: "done",
        stepCount: 4,
      });
    });

    test("a rejected write leaves later mutations working", async () => {
      breakDataDir();
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      }).catch(() => {});

      rmSync(join(workspaceDir, "data"));
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });

      expect(readActivationProgress().tasks["draft-email"]).toMatchObject({
        status: "started",
        conversationId: "conv-1",
      });
    });
  });

  describe("one task per conversation", () => {
    test("a second task takes the conversation and the first is unlinked", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await startActivationTask({
        taskId: "book-travel",
        conversationId: "conv-1",
      });

      const tasks = readActivationProgress().tasks;
      expect(Object.keys(tasks)).toEqual(["book-travel"]);
      expect(tasks["book-travel"]).toMatchObject({
        status: "started",
        conversationId: "conv-1",
      });
    });

    test("completion reaches the latest task, not a stranded one", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await startActivationTask({
        taskId: "book-travel",
        conversationId: "conv-1",
      });

      await bumpActivationStepCount("conv-1");
      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 3,
        endedAwaitingUser: false,
        artifacts: [{ workspacePath: "trips/plan.md", displayName: "plan.md" }],
      });

      const tasks = readActivationProgress().tasks;
      expect(tasks["draft-email"]).toBeUndefined();
      expect(tasks["book-travel"]).toMatchObject({
        status: "done",
        stepCount: 3,
        artifacts: [{ workspacePath: "trips/plan.md", displayName: "plan.md" }],
      });
    });

    test("re-starting a done task leaves the task running there alone", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 1,
        endedAwaitingUser: false,
        artifacts: [],
      });
      await startActivationTask({
        taskId: "book-travel",
        conversationId: "conv-1",
      });

      // The finished task cannot relink, so it has no claim on the
      // conversation and must not evict the task that is working it.
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });

      const tasks = readActivationProgress().tasks;
      expect(tasks["draft-email"]).toMatchObject({ status: "done" });
      expect(tasks["book-travel"]).toMatchObject({
        status: "started",
        conversationId: "conv-1",
      });
    });

    test("a done task keeps its record when a new task takes the conversation", async () => {
      await startActivationTask({
        taskId: "draft-email",
        conversationId: "conv-1",
      });
      await markActivationTurnComplete({
        conversationId: "conv-1",
        toolCallCount: 1,
        endedAwaitingUser: false,
        artifacts: [],
      });
      await startActivationTask({
        taskId: "book-travel",
        conversationId: "conv-1",
      });

      const tasks = readActivationProgress().tasks;
      expect(tasks["draft-email"]).toMatchObject({
        status: "done",
        conversationId: "conv-1",
      });
      expect(tasks["book-travel"]).toMatchObject({ status: "started" });
    });
  });
});
