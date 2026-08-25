/**
 * Tests for the run store.
 *
 * Strategy: stub the feed writer, the toast publisher, and the notification
 * pipeline via `mock.module()` and inspect the recorded calls. The unit under
 * test is the lifecycle contract, not persistence:
 *
 *  - short routine work leaves no trace
 *  - progress rewrites one row rather than appending a stream of them
 *  - only the three notifying transitions enter the pipeline
 *  - a run nothing is driving is closed as interrupted
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedItem } from "../../api/responses/home.js";

const appendedItems: FeedItem[] = [];
let feedItems: FeedItem[] = [];

mock.module("../../home/feed-writer.js", () => ({
  appendFeedItem: async (item: FeedItem) => {
    appendedItems.push(item);
    const idx = feedItems.findIndex((existing) => existing.id === item.id);
    if (idx === -1) {
      feedItems.push(item);
    } else {
      feedItems[idx] = item;
    }
  },
  readHomeFeed: () => ({
    version: 2 as const,
    items: feedItems,
    updatedAt: new Date().toISOString(),
  }),
}));

const toastedItems: FeedItem[] = [];
mock.module("../../home/publish-feed-toast.js", () => ({
  publishFeedToast: (item: FeedItem) => {
    toastedItems.push(item);
    return true;
  },
}));

const emittedSignals: Array<Record<string, unknown>> = [];
mock.module("../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emittedSignals.push(params);
    return {
      signalId: "sig",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
      pipelineFailed: false,
    };
  },
}));

const {
  markRunInterrupted,
  reconcileOrphanedRuns,
  resetRunStoreForTests,
  runItemId,
  startRun,
  SURFACE_DELAY_MS,
} = await import("../run-store.js");

/** Let the surface timer fire, so a run "outlives" the delay without waiting. */
async function passSurfaceDelay(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SURFACE_DELAY_MS + 20));
}

beforeEach(() => {
  appendedItems.length = 0;
  toastedItems.length = 0;
  emittedSignals.length = 0;
  feedItems = [];
  resetRunStoreForTests();
});

describe("startRun", () => {
  test("work that finishes routinely inside the surface window leaves no trace", async () => {
    // The delay is what stops the feed filling with rows for work nobody was
    // waiting on. A sub-second subagent call never flickers a spinner.
    const run = startRun({ kind: "subagent", label: "Quick lookup" });
    await run.succeed();

    expect(appendedItems).toHaveLength(0);
    expect(emittedSignals).toHaveLength(0);
  });

  test("a notable success surfaces even when it finishes fast", async () => {
    const run = startRun({ kind: "skill_learning", label: "Learned a skill" });
    await run.succeed({ notable: true, summary: "Wrote linear-triage." });

    expect(appendedItems).toHaveLength(1);
    expect(appendedItems[0]!.bucket).toBe("worth_knowing");
    expect(appendedItems[0]!.summary).toBe("Wrote linear-triage.");
  });

  test("a failure surfaces even when it finishes fast", async () => {
    const run = startRun({ kind: "scheduled_run", label: "Morning digest" });
    await run.fail({ reason: "The model provider did not answer." });

    expect(appendedItems).toHaveLength(1);
    expect(appendedItems[0]!.run?.state).toBe("failed");
    expect(appendedItems[0]!.run?.retryable).toBe(true);
  });

  test("work that outlives the delay gets a live row", async () => {
    startRun({ kind: "skill_learning", label: "Learning skill: linear-triage" });
    await passSurfaceDelay();

    expect(appendedItems).toHaveLength(1);
    const row = appendedItems[0]!;
    expect(row.type).toBe("run");
    expect(row.bucket).toBe("activity");
    expect(row.run?.state).toBe("running");
    // A live spinner is a status, not an unread message: it must not light
    // the bell's unread dot.
    expect(row.status).toBe("seen");
    expect(row.title).toBe("Learning skill: linear-triage");
  });

  test("progress rewrites the one row rather than appending a stream", async () => {
    const run = startRun({ kind: "subagent", label: "Competitor research" });
    await passSurfaceDelay();

    run.progress("Reading the first source");
    run.progress("Reading the second source");
    await run.succeed({ notable: true, summary: "Found three competitors." });

    // One row id throughout, so the list never reshuffles under a reader.
    const ids = new Set(appendedItems.map((item) => item.id));
    expect(ids.size).toBe(1);
    expect(feedItems).toHaveLength(1);
    expect(feedItems[0]!.run?.state).toBe("succeeded");
  });

  test("start and progress never enter the notification pipeline", async () => {
    const run = startRun({ kind: "subagent", label: "Long job" });
    await passSurfaceDelay();
    run.progress("Halfway");

    expect(emittedSignals).toHaveLength(0);
    await run.succeed();
    // A routine success is silent too: the default is not "always".
    expect(emittedSignals).toHaveLength(0);
  });

  test.each([
    ["needs_input", "run.needs_input"],
    ["failed", "run.failed"],
  ])("a %s transition enters the pipeline exactly once", async (state, event) => {
    const run = startRun({ kind: "subagent", label: "Blocked job" });
    if (state === "needs_input") {
      await run.needsInput("Which fare should it take?");
    } else {
      await run.fail({ reason: "It could not reach the provider." });
    }

    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0]!.sourceEventName).toBe(event);
    // Runs own their own feed row, so the pipeline must not mirror a second,
    // frozen copy of the same work beside the live one.
    expect(emittedSignals[0]!.suppressHomeFeedMirror).toBe(true);
  });

  test("a needs-input run moves to the top section and asks for attention", async () => {
    const run = startRun({ kind: "subagent", label: "Booking flights" });
    await run.needsInput("Which of the two fares?");

    const row = appendedItems.at(-1)!;
    expect(row.bucket).toBe("needs_you");
    expect(row.status).toBe("new");
  });

  test("a silent run never notifies, whatever it does", async () => {
    const run = startRun({ kind: "heartbeat", label: "Heartbeat", silent: true });
    await run.fail({ reason: "The model provider did not answer." });

    expect(emittedSignals).toHaveLength(0);
    // Its row stays in Activity: a failure the user cannot act on belongs in
    // the System health counter, not in the bell.
    expect(appendedItems.at(-1)!.bucket).toBe("activity");
  });

  test("a second transition after a terminal one is ignored", async () => {
    const run = startRun({ kind: "subagent", label: "Job" });
    await run.fail({ reason: "It stopped." });
    const afterFail = appendedItems.length;

    await run.succeed({ notable: true });

    expect(appendedItems).toHaveLength(afterFail);
    expect(emittedSignals).toHaveLength(1);
  });

  test("the same work started twice inside the window collapses onto one run", () => {
    const first = startRun({
      kind: "heartbeat",
      label: "Heartbeat",
      collapseKey: "background-job:heartbeat",
    });
    const second = startRun({
      kind: "heartbeat",
      label: "Heartbeat",
      collapseKey: "background-job:heartbeat",
    });

    expect(second.runId).toBe(first.runId);
  });

  test("a child settles its share of the root's count", async () => {
    const root = startRun({ kind: "subagent", label: "Competitor research" });
    const childA = startRun({
      kind: "subagent",
      label: "Source A",
      parentRunId: root.runId,
    });
    startRun({
      kind: "subagent",
      label: "Source B",
      parentRunId: root.runId,
    });
    await passSurfaceDelay();

    await childA.succeed();

    const rootRow = feedItems.find((item) => item.id === runItemId(root.runId))!;
    expect(rootRow.run?.childTotal).toBe(2);
    expect(rootRow.run?.childDone).toBe(1);
  });
});

describe("reconcileOrphanedRuns", () => {
  test("closes a row whose run is not live and offers a re-run", async () => {
    // The startup case: nothing is live yet, so every non-terminal row left
    // by the previous process is by definition orphaned.
    feedItems = [
      {
        id: "run:ghost",
        type: "run",
        bucket: "activity",
        priority: 30,
        title: "Interrupted work",
        summary: "Running.",
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: "seen",
        run: {
          runId: "ghost",
          kind: "subagent",
          state: "running",
          startedAt: new Date().toISOString(),
        },
      },
    ];

    const closed = await reconcileOrphanedRuns();

    expect(closed).toBe(1);
    expect(feedItems[0]!.run?.state).toBe("interrupted");
    expect(feedItems[0]!.run?.retryable).toBe(true);
    expect(feedItems[0]!.run?.endedAt).toBeTruthy();
  });

  test("leaves a live run alone", async () => {
    const run = startRun({ kind: "subagent", label: "Still going" });
    await passSurfaceDelay();

    const closed = await reconcileOrphanedRuns();

    expect(closed).toBe(0);
    expect(
      feedItems.find((item) => item.id === runItemId(run.runId))!.run?.state,
    ).toBe("running");
  });

  test("closes a run still going after the maximum age, live or not", async () => {
    const run = startRun({ kind: "subagent", label: "Wedged" });
    await passSurfaceDelay();
    const rowId = runItemId(run.runId);
    const row = feedItems.find((item) => item.id === rowId)!;
    // Backdate past the 24-hour ceiling.
    row.run = {
      ...row.run!,
      startedAt: new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString(),
    };

    const closed = await reconcileOrphanedRuns();

    expect(closed).toBe(1);
    expect(feedItems.find((item) => item.id === rowId)!.run?.state).toBe(
      "interrupted",
    );
  });

  test("is idempotent: a second pass closes nothing", async () => {
    feedItems = [
      {
        id: "run:ghost",
        type: "run",
        bucket: "activity",
        priority: 30,
        summary: "Running.",
        timestamp: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        status: "seen",
        run: {
          runId: "ghost",
          kind: "subagent",
          state: "running",
          startedAt: new Date().toISOString(),
        },
      },
    ];

    await reconcileOrphanedRuns();
    expect(await reconcileOrphanedRuns()).toBe(0);
  });
});

describe("markRunInterrupted", () => {
  test("is a no-op on a row that already finished", async () => {
    const finished: FeedItem = {
      id: "run:done",
      type: "run",
      bucket: "activity",
      priority: 30,
      summary: "Finished.",
      timestamp: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      status: "seen",
      run: {
        runId: "done",
        kind: "subagent",
        state: "succeeded",
        startedAt: new Date().toISOString(),
      },
    };

    await markRunInterrupted(finished);

    expect(appendedItems).toHaveLength(0);
  });
});
