/**
 * Tests for the skill-update receipt job: the pending-row merge rules the
 * burst boundary rests on, when a receipt is announced, the sibling path an
 * entry landing mid-evaluation takes, and the conversation purge.
 *
 * The job queue runs for real on the test workspace's memory database; the
 * notification pipeline and the conversation reads are stubbed at their
 * module boundaries. `mock.module` is process-global and leaks into sibling
 * files in a directory run, so each stub delegates to the real
 * implementation unless this test is actively running.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { eq } from "drizzle-orm";

import { setConfig } from "../../../../__tests__/helpers/set-config.js";
import { getMemoryDb } from "../../../../persistence/db-connection.js";
import { initializeDb } from "../../../../persistence/db-init.js";
import { memoryJobs } from "../../../../persistence/schema/index.js";

const realEmitSignal = {
  ...(await import("../../../../notifications/emit-signal.js")),
};
const realPluginApi = { ...(await import("@vellumai/plugin-api")) };

let active = false;
/** What the stubbed pipeline answers, per emit, in order. */
let emitOutcomes: Array<{ pipelineFailed?: boolean; reason?: string }> = [];
const emits: Array<
  Parameters<typeof realEmitSignal.emitNotificationSignal>[0]
> = [];
/** Runs that are processing; any other conversation reads as idle. */
const runs = new Map<string, "live" | "idle">();
/** Conversations, run or source, that no longer exist. */
const gone = new Set<string>();
/** Runs inside a liveness read, so a test can land an entry mid-evaluation. */
let onLivenessRead: (() => void) | null = null;

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
    return {
      signalId: `sig-${emits.length}`,
      deduplicated: false,
      dispatched: true,
      reason: outcome.reason ?? "ok",
      selectedChannels: [],
      deliveryResults: [],
      receiptClass: "unknown" as const,
      pipelineFailed: outcome.pipelineFailed ?? false,
    };
  },
}));

mock.module("@vellumai/plugin-api", () => ({
  ...realPluginApi,
  getConversation: async (id: string) =>
    active ? (gone.has(id) ? null : { id }) : realPluginApi.getConversation(id),
  isConversationProcessing: async (id: string) => {
    if (!active) {
      return realPluginApi.isConversationProcessing(id);
    }
    onLivenessRead?.();
    return runs.get(id) === "live";
  },
}));

setConfig("memory", { enabled: true });
await initializeDb();

const {
  parseSkillUpdateReceiptPayload,
  removeSkillUpdateReceiptEntriesForConversation,
  upsertSkillUpdateReceiptJob,
} = await import("../../../../persistence/jobs-store.js");
const {
  composeSkillUpdateReceiptCopy,
  decideSkillUpdateReceiptSeal,
  recordSkillUpdate,
  SKILL_UPDATE_RECEIPT_CAP_MS,
  SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS,
  SKILL_UPDATE_RECEIPT_QUIET_MS,
  skillUpdateReceiptDedupeKey,
  skillUpdateReceiptJob,
  skillUpdateReceiptSourceContextId,
} = await import("../skill-update-receipt-job.js");

beforeEach(() => {
  active = true;
  getMemoryDb()!.delete(memoryJobs).run();
  emitOutcomes = [];
  emits.length = 0;
  runs.clear();
  gone.clear();
  onLivenessRead = null;
});

afterAll(() => {
  active = false;
});

interface Row {
  id: string;
  status: string;
  runAfter: number;
  payload: string;
}

function rows(): Row[] {
  return getMemoryDb()!
    .select({
      id: memoryJobs.id,
      status: memoryJobs.status,
      runAfter: memoryJobs.runAfter,
      payload: memoryJobs.payload,
    })
    .from(memoryJobs)
    .where(eq(memoryJobs.type, "skill_update_receipt"))
    .all();
}

function pending(): Row[] {
  return rows().filter((row) => row.status === "pending");
}

function entryIds(row: Row): string[] {
  return (parseSkillUpdateReceiptPayload(row.payload)?.entries ?? []).map(
    (entry) => entry.entryId,
  );
}

/** Claim the one pending row the way the worker does, and hand it to the handler. */
async function runClaimed(): Promise<void> {
  const [row] = pending();
  if (!row) {
    throw new Error("no pending receipt to claim");
  }
  getMemoryDb()!
    .update(memoryJobs)
    .set({ status: "running", startedAt: Date.now() })
    .where(eq(memoryJobs.id, row.id))
    .run();
  const resolution = await skillUpdateReceiptJob({
    id: row.id,
    type: "skill_update_receipt",
    payload: JSON.parse(row.payload) as Record<string, unknown>,
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: row.runAfter,
    lastError: null,
    startedAt: Date.now(),
    createdAt: 0,
    updatedAt: 0,
  });
  getMemoryDb()!
    .update(memoryJobs)
    .set({
      status:
        resolution && resolution.queueResolution === "retryable"
          ? "pending"
          : "completed",
    })
    .where(eq(memoryJobs.id, row.id))
    .run();
}

function record(
  id: string,
  skillId: string,
  at: number,
  extra: { run?: string; source?: string } = {},
): void {
  const run = extra.run ?? "run-1";
  runs.set(run, runs.get(run) ?? "idle");
  recordSkillUpdate(
    {
      entryId: id,
      skillId,
      name: `Skill ${skillId}`,
      changeSummary: `summary ${id}`,
      runConversationId: run,
      ...(extra.source ? { sourceConversationId: extra.source } : {}),
    },
    at,
  );
}

describe("upsertSkillUpdateReceiptJob", () => {
  test("every append lands on the one pending row, keyed by entry id", () => {
    record("e1", "a", 1_000);
    record("e2", "b", 2_000);
    record("e1", "a", 9_000);

    expect(pending()).toHaveLength(1);
    const [row] = pending();
    expect(entryIds(row!)).toEqual(["e1", "e2"]);
    expect(parseSkillUpdateReceiptPayload(row!.payload)).toMatchObject({
      firstEntryAt: 1_000,
      lastEntryAt: 9_000,
    });
  });

  test("the merge keeps the earliest firstEntryAt, so a stream of rewrites cannot ratchet the cap", () => {
    upsertSkillUpdateReceiptJob({
      firstEntryAt: 5_000,
      lastEntryAt: 5_000,
      entries: [],
    });
    upsertSkillUpdateReceiptJob({
      firstEntryAt: 1_000,
      lastEntryAt: 1_000,
      entries: [],
    });
    upsertSkillUpdateReceiptJob({
      firstEntryAt: 7_000,
      lastEntryAt: 7_000,
      entries: [],
    });

    expect(parseSkillUpdateReceiptPayload(pending()[0]!.payload)).toMatchObject(
      { firstEntryAt: 1_000, lastEntryAt: 7_000 },
    );
  });

  test("the earliest runAfter wins, so a later append never pushes the check out", () => {
    record("e1", "a", 1_000);
    record("e2", "b", 50_000);

    expect(pending()[0]!.runAfter).toBe(1_000 + SKILL_UPDATE_RECEIPT_QUIET_MS);
  });

  test("a running row never merges: an append during evaluation opens a sibling", () => {
    record("e1", "a", 1_000);
    getMemoryDb()!
      .update(memoryJobs)
      .set({ status: "running" })
      .where(eq(memoryJobs.id, pending()[0]!.id))
      .run();

    record("e2", "b", 2_000);

    expect(rows()).toHaveLength(2);
    expect(pending()).toHaveLength(1);
    expect(entryIds(pending()[0]!)).toEqual(["e2"]);
  });
});

describe("decideSkillUpdateReceiptSeal", () => {
  const receipt = { firstEntryAt: 0, lastEntryAt: 10_000 };

  test("seals on the quiet window once every run has finished", () => {
    expect(
      decideSkillUpdateReceiptSeal({
        receipt,
        anyRunLive: false,
        now: 10_000 + SKILL_UPDATE_RECEIPT_QUIET_MS,
      }),
    ).toEqual({ seal: "quiet" });
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

  test("the cap seals a live, never-quiet burst", () => {
    expect(
      decideSkillUpdateReceiptSeal({
        receipt: { firstEntryAt: 0, lastEntryAt: SKILL_UPDATE_RECEIPT_CAP_MS },
        anyRunLive: true,
        now: SKILL_UPDATE_RECEIPT_CAP_MS,
      }),
    ).toEqual({ seal: "cap" });
  });
});

describe("copy and source context", () => {
  test("one skill is named, several are counted, every summary is in the body", () => {
    const entries = [
      {
        entryId: "e1",
        skillId: "a",
        name: "Skill a",
        changeSummary: "s1",
        runConversationId: "r",
        createdAt: 1,
      },
      {
        entryId: "e2",
        skillId: "b",
        name: "Skill b",
        changeSummary: "s2",
        runConversationId: "r",
        createdAt: 2,
      },
      {
        entryId: "e3",
        skillId: "a",
        name: "Skill a",
        changeSummary: "s3",
        runConversationId: "r",
        createdAt: 3,
      },
    ];
    expect(composeSkillUpdateReceiptCopy(entries)).toEqual({
      title: "2 skills updated",
      body: "- Skill a: s1\n- Skill b: s2\n- Skill a: s3",
    });
    expect(composeSkillUpdateReceiptCopy(entries.slice(0, 1)).title).toBe(
      "Skill updated: Skill a",
    );
    expect(
      skillUpdateReceiptSourceContextId("job", [
        { ...entries[0]!, sourceConversationId: "conv-1" },
        { ...entries[1]!, sourceConversationId: "conv-1" },
      ]),
    ).toBe("conv-1");
    expect(
      skillUpdateReceiptSourceContextId("job", [
        { ...entries[0]!, sourceConversationId: "conv-1" },
        { ...entries[1]!, sourceConversationId: "conv-2" },
      ]),
    ).toBe("skill-update-receipt:job");
    // A rewrite of unknown lineage cannot be attributed to the known one.
    expect(
      skillUpdateReceiptSourceContextId("job", [
        { ...entries[0]!, sourceConversationId: "conv-1" },
        entries[1]!,
      ]),
    ).toBe("skill-update-receipt:job");
  });
});

describe("skillUpdateReceiptJob", () => {
  test("a quiet burst is announced once, with every entry, under the row's key", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10;
    record("e1", "a", start, { source: "conv-1" });
    record("e2", "b", start + 1, { source: "conv-2" });
    record("e3", "a", start + 2);
    const [row] = pending();

    await runClaimed();

    expect(emits).toHaveLength(1);
    const emit = emits[0]!;
    expect(emit.dedupeKey).toBe(skillUpdateReceiptDedupeKey(row!.id));
    expect(emit.sourceContextId).toBe(`skill-update-receipt:${row!.id}`);
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
    expect(pending()).toHaveLength(0);
  });

  test("a source conversation deleted while the row was claimed is left out of the announcement", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10;
    record("e1", "a", start, { source: "conv-deleted" });
    record("e2", "b", start + 1, { source: "conv-kept" });
    record("e3", "c", start + 2);
    onLivenessRead = () => gone.add("conv-deleted");

    await runClaimed();

    expect(emits).toHaveLength(1);
    const payload = emits[0]!.contextPayload as Record<string, unknown>;
    expect(
      (payload.updates as Array<{ skillId: string }>).map((u) => u.skillId),
    ).toEqual(["b", "c"]);
  });

  test("a receipt whose surviving entries share one source still links to it", async () => {
    // Two sources, one deleted during evaluation: the announcement is the
    // survivor's rewrites alone, so its context is the survivor's
    // conversation, not the multi-source sentinel.
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10;
    record("e1", "a", start, { source: "conv-deleted" });
    record("e2", "b", start + 1, { source: "conv-kept" });
    record("e3", "b", start + 2, { source: "conv-kept" });
    onLivenessRead = () => gone.add("conv-deleted");

    await runClaimed();

    expect(emits).toHaveLength(1);
    expect(emits[0]!.sourceContextId).toBe("conv-kept");
    expect((emits[0]!.contextPayload as Record<string, unknown>).skillId).toBe(
      "b",
    );
  });

  test("a receipt whose every source was deleted announces nothing", async () => {
    record("e1", "a", Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10, {
      source: "conv-deleted",
    });
    gone.add("conv-deleted");

    await runClaimed();

    expect(emits).toHaveLength(0);
    expect(pending()).toHaveLength(0);
  });

  test("a one-skill, one-source receipt carries both ids the footer links from", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10;
    record("e1", "a", start, { source: "conv-1" });
    record("e2", "a", start + 1, { source: "conv-1" });

    await runClaimed();

    expect(emits[0]!.sourceContextId).toBe("conv-1");
    expect((emits[0]!.contextPayload as Record<string, unknown>).skillId).toBe(
      "a",
    );
  });

  test("nothing is announced before the quiet window; the payload moves to a row due at its end", async () => {
    const start = Date.now() - 1_000;
    record("e1", "a", start);

    await runClaimed();

    expect(emits).toHaveLength(0);
    const [next] = pending();
    expect(entryIds(next!)).toEqual(["e1"]);
    expect(next!.runAfter).toBe(start + SKILL_UPDATE_RECEIPT_QUIET_MS);
  });

  test("a live contributing run holds the announcement; an unrelated live run and a deleted run do not", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10;
    record("e1", "a", start, { run: "run-1" });
    runs.set("run-1", "live");
    runs.set("run-other", "live");

    await runClaimed();
    expect(emits).toHaveLength(0);
    expect(pending()[0]!.runAfter - Date.now()).toBeLessThanOrEqual(
      SKILL_UPDATE_RECEIPT_LIVE_RUN_RECHECK_MS,
    );

    gone.add("run-1");
    await runClaimed();
    expect(emits).toHaveLength(1);
  });

  test("the cap announces a burst whose run is still live", async () => {
    record("e1", "a", Date.now() - SKILL_UPDATE_RECEIPT_CAP_MS, {
      run: "run-1",
    });
    record("e2", "b", Date.now() - 1, { run: "run-1" });
    runs.set("run-1", "live");

    await runClaimed();

    expect(emits).toHaveLength(1);
  });

  test("an entry landing mid-evaluation joins the burst: the row merges into the sibling and announces nothing", async () => {
    const start = Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10;
    record("e1", "a", start, { run: "run-1" });
    let landed = false;
    onLivenessRead = () => {
      if (!landed) {
        landed = true;
        record("late", "b", Date.now(), { run: "run-2" });
      }
    };

    await runClaimed();

    expect(emits).toHaveLength(0);
    expect(pending()).toHaveLength(1);
    // Chronological, although the sibling held the later entry first.
    expect(entryIds(pending()[0]!)).toEqual(["e1", "late"]);
    // The merged row keeps the burst's earliest stamp, so its cap is not
    // pushed out by the late entry.
    expect(
      parseSkillUpdateReceiptPayload(pending()[0]!.payload)?.firstEntryAt,
    ).toBe(start);
  });

  test("an entry after the announcement opens the next receipt", async () => {
    record("e1", "a", Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10);
    await runClaimed();

    record("e2", "b", Date.now());

    expect(emits).toHaveLength(1);
    expect(entryIds(pending()[0]!)).toEqual(["e2"]);
  });

  test("a failed pipeline is reported retryable and keeps the row", async () => {
    record("e1", "a", Date.now() - SKILL_UPDATE_RECEIPT_QUIET_MS - 10);
    emitOutcomes = [{ pipelineFailed: true, reason: "boom" }];

    await runClaimed();

    expect(emits).toHaveLength(1);
    expect(pending()).toHaveLength(1);
    expect(entryIds(pending()[0]!)).toEqual(["e1"]);
  });

  test("a malformed payload is dropped", async () => {
    getMemoryDb()!
      .insert(memoryJobs)
      .values({
        id: "bad",
        type: "skill_update_receipt",
        payload: JSON.stringify({ nope: true }),
        status: "pending",
        attempts: 0,
        deferrals: 0,
        runAfter: 0,
        lastError: null,
        createdAt: 0,
        updatedAt: 0,
      })
      .run();

    await runClaimed();

    expect(emits).toHaveLength(0);
    expect(pending()).toHaveLength(0);
  });
});

describe("removeSkillUpdateReceiptEntriesForConversation", () => {
  test("drops a deleted source conversation's entries, recomputes the bounds, and deletes an emptied row", () => {
    record("e1", "a", 1_000, { source: "conv-gone" });
    record("e2", "b", 2_000, { source: "conv-kept" });
    record("e3", "c", 3_000, { source: "conv-gone" });

    removeSkillUpdateReceiptEntriesForConversation("conv-gone");

    expect(entryIds(pending()[0]!)).toEqual(["e2"]);
    // Both edge entries went, so the burst's window is now e2's alone.
    expect(parseSkillUpdateReceiptPayload(pending()[0]!.payload)).toMatchObject(
      { firstEntryAt: 2_000, lastEntryAt: 2_000 },
    );

    removeSkillUpdateReceiptEntriesForConversation("conv-kept");
    expect(rows()).toHaveLength(0);
  });

  test("a garbage-collected run conversation is not a purge key: its entries stay", () => {
    record("e1", "a", 1, { run: "run-gc" });
    record("e2", "b", 2, { run: "run-2" });

    removeSkillUpdateReceiptEntriesForConversation("run-gc");

    expect(entryIds(pending()[0]!)).toEqual(["e1", "e2"]);
  });
});
