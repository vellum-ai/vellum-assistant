/**
 * Tests for migration 335: collapsing duplicate pending memory-v2 maintenance
 * jobs (`memory_v2_reembed` / `memory_v3_maintain` duplicates, the full
 * pending `embed_concept_page` fan-out) left behind by pre-coalescing
 * enqueues.
 *
 * Runs against real workspace databases (`initializeDb()`) because the purge
 * loop dispatches batches via `runAsyncSqlite` against the memory DB file.
 * `initializeDb()` already ran the step once (no-op on an empty queue), so
 * each test seeds `memory_jobs` directly and calls the exported function.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";

const { getDb, getMemorySqlite } = await import("../db-connection.js");
const { initializeDb } = await import("../db-init.js");
const { migrateCollapseMemoryEmbedBacklog } =
  await import("./335-collapse-memory-embed-backlog.js");

await initializeDb();

let rowSeq = 0;

/** Insert a `memory_jobs` row directly; ids/rowids ascend in seed order. */
function seedJob(
  type: string,
  status: string,
  payload: Record<string, unknown> = {},
): string {
  rowSeq += 1;
  const id = `seed-${rowSeq}`;
  const stamp = 1000 + rowSeq;
  getMemorySqlite()!
    .query(
      `INSERT INTO memory_jobs
         (id, type, payload, status, attempts, deferrals, run_after, last_error, created_at, updated_at)
       VALUES (?, ?, ?, ?, 0, 0, ?, NULL, ?, ?)`,
    )
    .run(id, type, JSON.stringify(payload), status, stamp, stamp, stamp);
  return id;
}

function idsWhere(type: string, status: string): string[] {
  return (
    getMemorySqlite()!
      .query(
        `SELECT id FROM memory_jobs WHERE type = ? AND status = ? ORDER BY rowid`,
      )
      .all(type, status) as Array<{ id: string }>
  ).map((row) => row.id);
}

function statusOf(id: string): string | undefined {
  const row = getMemorySqlite()!
    .query(`SELECT status FROM memory_jobs WHERE id = ?`)
    .get(id) as { status: string } | null;
  return row?.status;
}

/** Full queue snapshot for idempotency comparisons. */
function snapshot(): Array<{ type: string; status: string; payload: string }> {
  return getMemorySqlite()!
    .query(
      `SELECT type, status, payload FROM memory_jobs ORDER BY type, status, payload`,
    )
    .all() as Array<{ type: string; status: string; payload: string }>;
}

beforeEach(() => {
  getMemorySqlite()!.run("DELETE FROM memory_jobs");
  setConfig("memory", {});
});

describe("migration 335: collapse memory embed backlog", () => {
  test("mixed backlog: embeds purged, reembed and v3 collapsed to earliest, everything else untouched", async () => {
    const keepReembed = seedJob("memory_v2_reembed", "pending");
    seedJob("memory_v2_reembed", "pending");
    seedJob("memory_v2_reembed", "pending");
    const keepV3 = seedJob("memory_v3_maintain", "pending");
    seedJob("memory_v3_maintain", "pending");
    for (const slug of ["alice", "alice", "bob", "bob", "carol"]) {
      seedJob("embed_concept_page", "pending", { slug });
    }
    const runningEmbed = seedJob("embed_concept_page", "running", {
      slug: "in-flight",
    });
    const completedEmbed = seedJob("embed_concept_page", "completed", {
      slug: "done",
    });
    const pendingSegment = seedJob("embed_segment", "pending", {
      segmentId: "msg-1:0",
    });

    await migrateCollapseMemoryEmbedBacklog(getDb());

    expect(idsWhere("embed_concept_page", "pending")).toEqual([]);
    expect(idsWhere("memory_v2_reembed", "pending")).toEqual([keepReembed]);
    expect(idsWhere("memory_v3_maintain", "pending")).toEqual([keepV3]);
    // Running/terminal rows and other job types are untouched — notably
    // embed_segment, whose pending rows carry distinct meaningful payloads.
    expect(statusOf(runningEmbed)).toBe("running");
    expect(statusOf(completedEmbed)).toBe("completed");
    expect(statusOf(pendingSegment)).toBe("pending");
  });

  test("pending embeds with no reembed → a replacement reembed is inserted", async () => {
    seedJob("embed_concept_page", "pending", { slug: "alice" });
    seedJob("embed_concept_page", "pending", { slug: "bob" });

    await migrateCollapseMemoryEmbedBacklog(getDb());

    expect(idsWhere("embed_concept_page", "pending")).toEqual([]);
    expect(idsWhere("memory_v2_reembed", "pending")).toHaveLength(1);
  });

  test("a running reembed suppresses the replacement insert", async () => {
    // A running row flips back to pending at the next worker boot
    // (`resetRunningJobsToPending`) and re-runs its full fan-out, so the
    // purged embeds are still regenerated.
    seedJob("memory_v2_reembed", "running");
    seedJob("embed_concept_page", "pending", { slug: "alice" });

    await migrateCollapseMemoryEmbedBacklog(getDb());

    expect(idsWhere("embed_concept_page", "pending")).toEqual([]);
    expect(idsWhere("memory_v2_reembed", "pending")).toEqual([]);
    expect(idsWhere("memory_v2_reembed", "running")).toHaveLength(1);
  });

  test("empty queue → no-op, nothing inserted", async () => {
    await migrateCollapseMemoryEmbedBacklog(getDb());

    expect(snapshot()).toEqual([]);
  });

  test("no pending embeds → no reembed inserted, duplicates still collapsed", async () => {
    const keep = seedJob("memory_v2_reembed", "pending");
    seedJob("memory_v2_reembed", "pending");

    await migrateCollapseMemoryEmbedBacklog(getDb());

    expect(idsWhere("memory_v2_reembed", "pending")).toEqual([keep]);
  });

  test("v2 explicitly disabled → embeds purged, all pending reembeds deleted, no insert", async () => {
    setConfig("memory", { v2: { enabled: false } });
    seedJob("memory_v2_reembed", "pending");
    seedJob("memory_v2_reembed", "pending");
    seedJob("embed_concept_page", "pending", { slug: "alice" });

    await migrateCollapseMemoryEmbedBacklog(getDb());

    expect(idsWhere("memory_v2_reembed", "pending")).toEqual([]);
    expect(idsWhere("embed_concept_page", "pending")).toEqual([]);
  });

  test("memory explicitly disabled → embeds purged, all pending reembeds deleted, no insert", async () => {
    setConfig("memory", { enabled: false });
    seedJob("memory_v2_reembed", "pending");
    seedJob("embed_concept_page", "pending", { slug: "alice" });

    await migrateCollapseMemoryEmbedBacklog(getDb());

    expect(idsWhere("memory_v2_reembed", "pending")).toEqual([]);
    expect(idsWhere("embed_concept_page", "pending")).toEqual([]);
  });

  test("running twice is idempotent", async () => {
    seedJob("memory_v2_reembed", "pending");
    seedJob("memory_v2_reembed", "pending");
    seedJob("embed_concept_page", "pending", { slug: "alice" });
    seedJob("embed_segment", "pending", { segmentId: "msg-1:0" });

    await migrateCollapseMemoryEmbedBacklog(getDb());
    const afterFirst = snapshot();
    await migrateCollapseMemoryEmbedBacklog(getDb());

    expect(snapshot()).toEqual(afterFirst);
  });
});
