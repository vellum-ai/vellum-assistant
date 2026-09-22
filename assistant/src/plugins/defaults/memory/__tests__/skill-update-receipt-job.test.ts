/**
 * Tests for the skill-update receipt tick: when the open receipt is sealed,
 * and how a sealed receipt's terminal state is read off what the
 * notification pipeline did with its one announcement.
 *
 * The pipeline, the feed file, the conversation reads, and the job queue are
 * stubbed at their module boundaries; the receipt store runs for real on an
 * in-memory memory database through the same `db-connection` stub the store
 * test uses. `mock.module` is process-global and leaks into sibling files in
 * a directory run, so every stub delegates to the real implementation
 * unless this test is actively running.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedItem } from "../../../../home/feed-types.js";
import type { EmitSignalResult } from "../../../../notifications/emit-signal.js";

const realDb = {
  ...(await import("../../../../persistence/db-connection.js")),
};
const realFeedWriter = {
  ...(await import("../../../../home/feed-writer.js")),
};
const realEmitSignal = {
  ...(await import("../../../../notifications/emit-signal.js")),
};
const realEventsStore = {
  ...(await import("../../../../notifications/events-store.js")),
};
const realJobsStore = {
  ...(await import("../../../../persistence/jobs-store.js")),
};
const realPluginApi = { ...(await import("@vellumai/plugin-api")) };
const realWatchdog = {
  ...(await import("../../../../telemetry/watchdog-events-store.js")),
};

let active = false;
let memorySqlite: Database;

/** What the stubbed pipeline answers, per emit, in order. */
let emitOutcomes: Array<Partial<EmitSignalResult>> = [];
const emits: Array<
  Parameters<typeof realEmitSignal.emitNotificationSignal>[0]
> = [];
/** Event ids the stubbed events store knows by dedupe key. */
const eventsByKey = new Map<string, string>();
/** Feed item ids the stubbed feed file holds. */
const feedItemIds = new Set<string>();
/** Ticks the stubbed queue was handed, as `runAfter` stamps. */
const enqueued: number[] = [];
let tickPending = false;
/** Run conversations: present and processing, present and idle, or gone. */
const runs = new Map<string, "live" | "idle">();
const watchdogEvents: Array<
  Parameters<typeof realWatchdog.recordWatchdogEvent>[0]
> = [];

mock.module("../../../../persistence/db-connection.js", () => ({
  ...realDb,
  getMemorySqlite: () => (active ? memorySqlite : realDb.getMemorySqlite()),
}));

mock.module("../../../../home/feed-writer.js", () => ({
  ...realFeedWriter,
  readHomeFeed: () =>
    active
      ? {
          version: 2,
          items: [...feedItemIds].map((id) => ({ id }) as FeedItem),
          updatedAt: "",
        }
      : realFeedWriter.readHomeFeed(),
}));

mock.module("../../../../notifications/emit-signal.js", () => ({
  ...realEmitSignal,
  emitNotificationSignal: async (
    params: Parameters<typeof realEmitSignal.emitNotificationSignal>[0],
  ) => {
    if (!active) {
      return realEmitSignal.emitNotificationSignal(params);
    }
    emits.push(params);
    const outcome = emitOutcomes.shift() ?? {};
    const signalId = outcome.signalId ?? `sig-${emits.length}`;
    return {
      signalId,
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      selectedChannels: [],
      deliveryResults: [],
      receiptClass: "unknown",
      pipelineFailed: false,
      ...outcome,
    } satisfies EmitSignalResult;
  },
}));

mock.module("../../../../notifications/events-store.js", () => ({
  ...realEventsStore,
  findEventIdByDedupeKey: (key: string) =>
    active
      ? (eventsByKey.get(key) ?? null)
      : realEventsStore.findEventIdByDedupeKey(key),
}));

mock.module("../../../../persistence/jobs-store.js", () => ({
  ...realJobsStore,
  enqueueMemoryJob: (type: string, payload: unknown, runAfter?: number) => {
    if (!active) {
      return realJobsStore.enqueueMemoryJob(
        type as Parameters<typeof realJobsStore.enqueueMemoryJob>[0],
        payload as Record<string, unknown>,
        runAfter,
      );
    }
    enqueued.push(runAfter ?? Date.now());
    tickPending = true;
    return "job-1";
  },
  hasPendingJobOfType: (type: string) =>
    active
      ? tickPending
      : realJobsStore.hasPendingJobOfType(
          type as Parameters<typeof realJobsStore.hasPendingJobOfType>[0],
        ),
  hasActiveJobOfType: (type: string) =>
    active
      ? tickPending
      : realJobsStore.hasActiveJobOfType(
          type as Parameters<typeof realJobsStore.hasActiveJobOfType>[0],
        ),
}));

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  getConversation: async (id: string) =>
    active ? (runs.has(id) ? { id } : null) : realPluginApi.getConversation(id),
  isConversationProcessing: async (id: string) =>
    active
      ? runs.get(id) === "live"
      : realPluginApi.isConversationProcessing(id),
}));

mock.module("../../../../telemetry/watchdog-events-store.js", () => ({
  ...realWatchdog,
  recordWatchdogEvent: (
    record: Parameters<typeof realWatchdog.recordWatchdogEvent>[0],
  ) => {
    if (!active) {
      return realWatchdog.recordWatchdogEvent(record);
    }
    watchdogEvents.push(record);
    return null;
  },
}));

const {
  composeSkillUpdateReceiptCopy,
  decideSkillUpdateReceiptSeal,
  SKILL_UPDATE_RECEIPT_CAP_MS,
  SKILL_UPDATE_RECEIPT_EMIT_RETRY_MS,
  SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS,
  SKILL_UPDATE_RECEIPT_QUIET_MS,
  skillUpdateReceiptDedupeKey,
  skillUpdateReceiptSourceContextId,
  skillUpdateReceiptTickJob,
} = await import("../skill-update-receipt-job.js");
const {
  listSkillUpdateReceiptEntries,
  readOpenSkillUpdateReceipt,
  recordSkillUpdate,
  sealSkillUpdateReceipt,
} = await import("../skill-update-receipt-store.js");

beforeEach(() => {
  active = true;
  memorySqlite = new Database(":memory:");
  emitOutcomes = [];
  emits.length = 0;
  eventsByKey.clear();
  feedItemIds.clear();
  enqueued.length = 0;
  tickPending = false;
  runs.clear();
  watchdogEvents.length = 0;
});

afterAll(() => {
  active = false;
});

const JOB = {
  id: "tick",
  type: "skill_update_receipt_tick" as const,
  payload: {},
  status: "running" as const,
  attempts: 0,
  deferrals: 0,
  runAfter: 0,
  lastError: null,
  startedAt: 0,
  createdAt: 0,
  updatedAt: 0,
};

function record(
  id: string,
  skillId: string,
  at: number,
  extra: { run?: string; source?: string } = {},
) {
  runs.set(extra.run ?? "run-1", runs.get(extra.run ?? "run-1") ?? "idle");
  const result = recordSkillUpdate(
    {
      entryId: id,
      skillId,
      name: `Skill ${skillId}`,
      changeSummary: `summary ${id}`,
      runConversationId: extra.run ?? "run-1",
      ...(extra.source ? { sourceConversationId: extra.source } : {}),
    },
    at,
  );
  if (!result.recorded) {
    throw new Error(result.reason);
  }
  return result.receiptId;
}

function receiptStatus(id: string): string {
  const row = memorySqlite
    .query(`SELECT status FROM skill_update_receipts WHERE id = ?`)
    .get(id) as { status: string };
  return row.status;
}

describe("decideSkillUpdateReceiptSeal", () => {
  const receipt = { firstEntryAt: 0, lastEntryAt: 10_000 };

  test("seals on the quiet window once every run has finished", () => {
    expect(
      decideSkillUpdateReceiptSeal({
        receipt,
        anyRunLive: false,
        now: 10_000 + SKILL_UPDATE_RECEIPT_QUIET_MS,
      }),
    ).toEqual({ seal: "quiet", withRev: true });
  });

  test("waits for the quiet window, checking again at its end", () => {
    expect(
      decideSkillUpdateReceiptSeal({ receipt, anyRunLive: false, now: 20_000 }),
    ).toEqual({
      seal: null,
      nextCheckAt: 10_000 + SKILL_UPDATE_RECEIPT_QUIET_MS,
    });
  });

  test("a live run holds the seal past the quiet window, on a short recheck", () => {
    const now = 10_000 + SKILL_UPDATE_RECEIPT_QUIET_MS;
    expect(
      decideSkillUpdateReceiptSeal({ receipt, anyRunLive: true, now }),
    ).toEqual({
      seal: null,
      nextCheckAt: now + SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS,
    });
  });

  test("the cap seals a live, never-quiet burst without a revision check", () => {
    expect(
      decideSkillUpdateReceiptSeal({
        receipt: { firstEntryAt: 0, lastEntryAt: SKILL_UPDATE_RECEIPT_CAP_MS },
        anyRunLive: true,
        now: SKILL_UPDATE_RECEIPT_CAP_MS,
      }),
    ).toEqual({ seal: "cap", withRev: false });
  });
});

describe("copy and source context", () => {
  test("one skill is named and several are counted, with every summary in the body", () => {
    record("e1", "a", 1);
    record("e2", "b", 2);
    record("e3", "a", 3);
    const entries = listSkillUpdateReceiptEntries(
      readOpenSkillUpdateReceipt()!.id,
    );

    expect(composeSkillUpdateReceiptCopy(entries)).toEqual({
      title: "2 skills updated",
      body: "- Skill a: summary e1\n- Skill b: summary e2\n- Skill a: summary e3",
    });
    expect(composeSkillUpdateReceiptCopy(entries.slice(0, 1)).title).toBe(
      "Skill updated: Skill a",
    );
  });

  test("names the one source conversation, else a sentinel that resolves to nothing", () => {
    record("e1", "a", 1, { source: "conv-1" });
    record("e2", "b", 2, { source: "conv-1" });
    const one = listSkillUpdateReceiptEntries(readOpenSkillUpdateReceipt()!.id);
    expect(skillUpdateReceiptSourceContextId("r", one)).toBe("conv-1");

    record("e3", "c", 3, { source: "conv-2" });
    const two = listSkillUpdateReceiptEntries(readOpenSkillUpdateReceipt()!.id);
    expect(skillUpdateReceiptSourceContextId("r", two)).toBe(
      "skill-update-receipt:r",
    );
  });
});

describe("skillUpdateReceiptTickJob: sealing", () => {
  test("a quiet burst is sealed and announced once, with every entry", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10;
    const id = record("e1", "a", start, { source: "conv-1" });
    record("e2", "b", start + 1, { source: "conv-2" });
    record("e3", "a", start + 2);
    feedItemIds.add("notif:sig-1");

    await skillUpdateReceiptTickJob(JOB);

    expect(emits).toHaveLength(1);
    const emit = emits[0]!;
    expect(emit.dedupeKey).toBe(skillUpdateReceiptDedupeKey(id));
    expect(emit.sourceContextId).toBe(`skill-update-receipt:${id}`);
    expect(emit.sourceChannel).toBe("assistant_tool");
    const payload = emit.contextPayload as Record<string, unknown>;
    expect(payload.title).toBe("2 skills updated");
    expect(payload.updates).toEqual([
      {
        skillId: "a",
        name: "Skill a",
        summary: "summary e1",
        conversationId: "conv-1",
      },
      {
        skillId: "b",
        name: "Skill b",
        summary: "summary e2",
        conversationId: "conv-2",
      },
      { skillId: "a", name: "Skill a", summary: "summary e3" },
    ]);
    expect(payload.skillId).toBeUndefined();
    expect(receiptStatus(id)).toBe("delivered");
    expect(watchdogEvents).toMatchObject([
      {
        checkName: "skill_update_receipt_settled",
        value: 3,
        detail: {
          terminal_state: "delivered",
          sealed_by: "quiet",
          distinct_skill_count: 2,
          distinct_source_count: 2,
        },
      },
    ]);
  });

  test("a one-skill, one-source receipt carries both ids the footer links from", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10;
    record("e1", "a", start, { source: "conv-1" });
    record("e2", "a", start + 1, { source: "conv-1" });
    feedItemIds.add("notif:sig-1");

    await skillUpdateReceiptTickJob(JOB);

    const emit = emits[0]!;
    expect(emit.sourceContextId).toBe("conv-1");
    expect((emit.contextPayload as Record<string, unknown>).skillId).toBe("a");
  });

  test("nothing is announced before the quiet window, and the next tick is queued at its end", async () => {
    const start = Date.now() - 1_000;
    record("e1", "a", start);

    await skillUpdateReceiptTickJob(JOB);

    expect(emits).toHaveLength(0);
    expect(enqueued).toEqual([start + SKILL_UPDATE_RECEIPT_QUIET_MS]);
  });

  test("a live contributing run holds the seal; an unrelated live run does not", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 1;
    record("e1", "a", start, { run: "run-1" });
    runs.set("run-1", "live");
    runs.set("run-other", "live");

    await skillUpdateReceiptTickJob(JOB);
    expect(emits).toHaveLength(0);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]! - Date.now()).toBeLessThanOrEqual(
      SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS,
    );

    runs.set("run-1", "idle");
    feedItemIds.add("notif:sig-1");
    await skillUpdateReceiptTickJob(JOB);
    expect(emits).toHaveLength(1);
  });

  test("a deleted run conversation counts as finished", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 1;
    record("e1", "a", start, { run: "run-gone" });
    runs.delete("run-gone");
    feedItemIds.add("notif:sig-1");

    await skillUpdateReceiptTickJob(JOB);

    expect(emits).toHaveLength(1);
  });

  test("the cap seals a burst whose run is still live", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_CAP_MS;
    const id = record("e1", "a", start, { run: "run-1" });
    record("e2", "b", Date.now() - 1, { run: "run-1" });
    runs.set("run-1", "live");
    feedItemIds.add("notif:sig-1");

    await skillUpdateReceiptTickJob(JOB);

    expect(emits).toHaveLength(1);
    expect(receiptStatus(id)).toBe("delivered");
    expect(watchdogEvents[0]).toMatchObject({ detail: { sealed_by: "cap" } });
  });

  test("an entry that lands during evaluation keeps the receipt open", async () => {
    // The tick's liveness read is where an append can interleave. Landing
    // the entry from inside that read reproduces an append that commits
    // between the evaluation's revision read and its seal.
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 1;
    const id = record("e1", "a", start, { run: "run-1" });
    let landed = false;
    const realIsProcessing = realPluginApi.isConversationProcessing;
    mock.module("@vellumai/plugin-api", () => ({
      ...realPluginApi,
      getConversation: async (conversationId: string) =>
        active
          ? { id: conversationId }
          : realPluginApi.getConversation(conversationId),
      isConversationProcessing: async (conversationId: string) => {
        if (!active) {
          return realIsProcessing(conversationId);
        }
        if (!landed) {
          landed = true;
          record("late", "b", Date.now(), { run: "run-2" });
        }
        return false;
      },
    }));

    await skillUpdateReceiptTickJob(JOB);

    expect(emits).toHaveLength(0);
    expect(receiptStatus(id)).toBe("open");
    expect(listSkillUpdateReceiptEntries(id)).toHaveLength(2);
    expect(readOpenSkillUpdateReceipt()?.id).toBe(id);
    expect(enqueued).toHaveLength(1);
  });

  test("an entry after the seal opens the next receipt and a tick is left for it", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 1;
    const first = record("e1", "a", start);
    const open = readOpenSkillUpdateReceipt()!;
    sealSkillUpdateReceipt({ id: open.id, rev: open.rev, sealedBy: "quiet" });
    const second = record("e2", "b", Date.now());
    feedItemIds.add("notif:sig-1");

    await skillUpdateReceiptTickJob(JOB);

    expect(second).not.toBe(first);
    expect(emits).toHaveLength(1);
    expect(receiptStatus(first)).toBe("delivered");
    expect(receiptStatus(second)).toBe("open");
    expect(enqueued).toHaveLength(1);
  });
});

describe("skillUpdateReceiptTickJob: delivery outcomes", () => {
  function sealedReceipt(): string {
    const id = record(
      "e1",
      "a",
      Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 1,
    );
    const open = readOpenSkillUpdateReceipt()!;
    sealSkillUpdateReceipt({ id: open.id, rev: open.rev, sealedBy: "quiet" });
    return id;
  }

  test("a quiet verdict that still wrote the feed row is delivered", async () => {
    const id = sealedReceipt();
    emitOutcomes = [
      { dispatched: false, reason: "Decision: shouldNotify=false" },
    ];
    feedItemIds.add("notif:sig-1");

    await skillUpdateReceiptTickJob(JOB);

    expect(receiptStatus(id)).toBe("delivered");
  });

  test("a dispatched announcement whose feed write failed is undelivered, not a declined verdict", async () => {
    const id = sealedReceipt();
    emitOutcomes = [{ dispatched: true, reason: "ok" }];

    await skillUpdateReceiptTickJob(JOB);
    await skillUpdateReceiptTickJob(JOB);

    expect(emits).toHaveLength(1);
    expect(receiptStatus(id)).toBe("undelivered");
    expect(watchdogEvents[0]).toMatchObject({
      detail: { terminal_state: "undelivered" },
    });
  });

  test("a verdict that declined the row settles without one, and is never re-announced", async () => {
    const id = sealedReceipt();
    emitOutcomes = [
      {
        dispatched: false,
        reason: "Signal blocked by deterministic checks: dedupe",
      },
    ];

    await skillUpdateReceiptTickJob(JOB);
    await skillUpdateReceiptTickJob(JOB);

    expect(emits).toHaveLength(1);
    expect(receiptStatus(id)).toBe("settled_no_row");
    expect(watchdogEvents[0]).toMatchObject({
      detail: { terminal_state: "settled_no_row" },
    });
  });

  test("a failed pipeline keeps the receipt sealed and retries after a delay, up to the bound", async () => {
    const id = sealedReceipt();
    emitOutcomes = [
      { pipelineFailed: true, reason: "boom" },
      { pipelineFailed: true, reason: "boom" },
      { pipelineFailed: true, reason: "boom" },
    ];

    await skillUpdateReceiptTickJob(JOB);
    expect(receiptStatus(id)).toBe("sealed");
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]! - Date.now()).toBeGreaterThan(
      SKILL_UPDATE_RECEIPT_EMIT_RETRY_MS - 1_000,
    );

    tickPending = false;
    await skillUpdateReceiptTickJob(JOB);
    tickPending = false;
    await skillUpdateReceiptTickJob(JOB);
    expect(emits).toHaveLength(3);
    expect(receiptStatus(id)).toBe("sealed");

    tickPending = false;
    await skillUpdateReceiptTickJob(JOB);
    expect(emits).toHaveLength(3);
    expect(receiptStatus(id)).toBe("undelivered");
    expect(watchdogEvents[0]).toMatchObject({
      detail: { terminal_state: "undelivered", emit_attempts: 4 },
    });
  });

  test("after a crash between the emit and the outcome, a row the earlier emit wrote means delivered", async () => {
    const id = sealedReceipt();
    eventsByKey.set(skillUpdateReceiptDedupeKey(id), "sig-earlier");
    feedItemIds.add("notif:sig-earlier");
    emitOutcomes = [
      { deduplicated: true, dispatched: false, reason: "dedupe" },
    ];

    await skillUpdateReceiptTickJob(JOB);

    expect(receiptStatus(id)).toBe("delivered");
  });

  test("after such a crash with no row, the receipt is undelivered and the key is left alone", async () => {
    // Nothing here can tell a crash before the verdict from a verdict this
    // job must not appeal, so it neither releases the key nor re-announces.
    const id = sealedReceipt();
    eventsByKey.set(skillUpdateReceiptDedupeKey(id), "sig-earlier");
    emitOutcomes = [
      { deduplicated: true, dispatched: false, reason: "dedupe" },
    ];

    await skillUpdateReceiptTickJob(JOB);
    await skillUpdateReceiptTickJob(JOB);

    expect(emits).toHaveLength(1);
    expect(receiptStatus(id)).toBe("undelivered");
    expect(watchdogEvents[0]).toMatchObject({
      detail: { terminal_state: "undelivered" },
    });
  });

  test("a delivered receipt is never announced again", async () => {
    const id = sealedReceipt();
    feedItemIds.add("notif:sig-1");

    await skillUpdateReceiptTickJob(JOB);
    await skillUpdateReceiptTickJob(JOB);

    expect(emits).toHaveLength(1);
    expect(receiptStatus(id)).toBe("delivered");
  });
});
