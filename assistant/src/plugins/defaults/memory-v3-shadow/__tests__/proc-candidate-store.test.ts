/**
 * Tests for `proc-candidate-store.ts` — the procedural-memory candidate
 * registry (migration 302):
 *   - upsert/get round-trip, including member-slug and explicit fields;
 *   - upsert conflict path refreshing only `goal`/`updated_at` while preserving
 *     `created_at` and the accumulated members/count/status/explicit fields;
 *   - `incrementCandidate` bumping the recurrence tally;
 *   - `listCandidatesByStatus` filtering to one lifecycle status;
 *   - `markCandidateStatus` walking the lifecycle;
 *   - `addMemberNote` set semantics (dedup, no-op for unknown clusters);
 *   - migration idempotence (run twice).
 *
 * `mock.module` is process-global and leaks into sibling files in a directory
 * run, so the db-connection stub DELEGATES to the real implementation unless
 * this test is actively running (`storeMockActive`, toggled in
 * beforeEach/afterAll). Mirrors `ever-injected-store.test.ts`.
 */

import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { createProcCandidatesTable } from "../../../../memory/migrations/302-create-proc-candidates.js";
import * as schema from "../../../../memory/schema.js";

const realDb = { ...(await import("../../../../memory/db-connection.js")) };

let storeMockActive = false;

let testSqlite: Database;
let testDb = makeDb();
function makeDb() {
  testSqlite = new Database(":memory:");
  const db = drizzle(testSqlite, { schema });
  createProcCandidatesTable(db);
  return db;
}

mock.module("../../../../memory/db-connection.js", () => ({
  ...realDb,
  getDb: () => (storeMockActive ? testDb : realDb.getDb()),
  getSqliteFrom: (db: unknown) =>
    storeMockActive
      ? testSqlite
      : realDb.getSqliteFrom(db as Parameters<typeof realDb.getSqliteFrom>[0]),
}));

const {
  addMemberNote,
  getCandidate,
  incrementCandidate,
  listCandidatesByStatus,
  markCandidateStatus,
  upsertCandidate,
} = await import("../proc-candidate-store.js");

beforeEach(() => {
  storeMockActive = true;
  testDb = makeDb();
});

afterAll(() => {
  storeMockActive = false;
});

describe("upsertCandidate / getCandidate", () => {
  test("round-trips a candidate cluster", () => {
    upsertCandidate(
      {
        clusterId: "cluster-1",
        goal: "draft the weekly status email",
        memberNoteSlugs: ["notes/a", "notes/b"],
        count: 2,
        status: "observing",
        explicit: true,
      },
      1_000,
    );

    expect(getCandidate("cluster-1")).toEqual({
      clusterId: "cluster-1",
      goal: "draft the weekly status email",
      memberNoteSlugs: ["notes/a", "notes/b"],
      count: 2,
      status: "observing",
      explicit: true,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
    expect(getCandidate("cluster-unknown")).toBeNull();
  });

  test("defaults member slugs, count, status, and explicit", () => {
    upsertCandidate({ clusterId: "cluster-1", goal: "do the thing" }, 1_000);
    expect(getCandidate("cluster-1")).toEqual({
      clusterId: "cluster-1",
      goal: "do the thing",
      memberNoteSlugs: [],
      count: 0,
      status: "observing",
      explicit: false,
      createdAt: 1_000,
      updatedAt: 1_000,
    });
  });

  test("re-upserting refreshes goal and updated_at but preserves created_at", () => {
    upsertCandidate({ clusterId: "cluster-1", goal: "first" }, 1_000);
    upsertCandidate({ clusterId: "cluster-1", goal: "second" }, 2_000);

    expect(getCandidate("cluster-1")).toEqual({
      clusterId: "cluster-1",
      goal: "second",
      memberNoteSlugs: [],
      count: 0,
      status: "observing",
      explicit: false,
      createdAt: 1_000,
      updatedAt: 2_000,
    });
  });

  test("re-upserting preserves accumulated members, count, status, and explicit", () => {
    // Seed a cluster that has accumulated evidence via the dedicated mutators.
    upsertCandidate(
      {
        clusterId: "cluster-1",
        goal: "first",
        memberNoteSlugs: ["notes/a", "notes/b"],
        count: 5,
        status: "ready",
        explicit: true,
      },
      1_000,
    );

    // A bare refresh-upsert (only the required fields) must not clobber the
    // accumulated member slugs, recurrence count, lifecycle status, or the
    // explicit flag — those are owned by the dedicated mutators.
    upsertCandidate({ clusterId: "cluster-1", goal: "second" }, 2_000);

    expect(getCandidate("cluster-1")).toEqual({
      clusterId: "cluster-1",
      goal: "second",
      memberNoteSlugs: ["notes/a", "notes/b"],
      count: 5,
      status: "ready",
      explicit: true,
      createdAt: 1_000,
      updatedAt: 2_000,
    });
  });
});

describe("incrementCandidate", () => {
  test("bumps the recurrence tally and stamps updated_at", () => {
    upsertCandidate({ clusterId: "cluster-1", goal: "g", count: 1 }, 1_000);
    incrementCandidate("cluster-1", 2_000);
    incrementCandidate("cluster-1", 3_000);

    const candidate = getCandidate("cluster-1");
    expect(candidate?.count).toBe(3);
    expect(candidate?.updatedAt).toBe(3_000);
  });
});

describe("listCandidatesByStatus", () => {
  test("filters to the requested status, newest update first", () => {
    upsertCandidate(
      { clusterId: "observing-1", goal: "g", status: "observing" },
      1_000,
    );
    upsertCandidate(
      { clusterId: "ready-1", goal: "g", status: "ready" },
      2_000,
    );
    upsertCandidate(
      { clusterId: "ready-2", goal: "g", status: "ready" },
      3_000,
    );
    upsertCandidate(
      { clusterId: "distilled-1", goal: "g", status: "distilled" },
      4_000,
    );

    expect(listCandidatesByStatus("ready").map((c) => c.clusterId)).toEqual([
      "ready-2",
      "ready-1",
    ]);
    expect(listCandidatesByStatus("observing").map((c) => c.clusterId)).toEqual(
      ["observing-1"],
    );
    expect(listCandidatesByStatus("distilled")).toHaveLength(1);
  });

  test("returns an empty list when no cluster has the status", () => {
    upsertCandidate(
      { clusterId: "cluster-1", goal: "g", status: "observing" },
      1_000,
    );
    expect(listCandidatesByStatus("ready")).toEqual([]);
  });
});

describe("markCandidateStatus", () => {
  test("walks a cluster through the lifecycle", () => {
    upsertCandidate({ clusterId: "cluster-1", goal: "g" }, 1_000);

    markCandidateStatus("cluster-1", "ready", 2_000);
    expect(getCandidate("cluster-1")?.status).toBe("ready");
    expect(listCandidatesByStatus("ready").map((c) => c.clusterId)).toEqual([
      "cluster-1",
    ]);

    markCandidateStatus("cluster-1", "distilled", 3_000);
    expect(getCandidate("cluster-1")?.status).toBe("distilled");
    expect(getCandidate("cluster-1")?.updatedAt).toBe(3_000);
    expect(listCandidatesByStatus("ready")).toEqual([]);
  });
});

describe("addMemberNote", () => {
  test("appends a slug, dedups, and is a no-op for unknown clusters", () => {
    upsertCandidate(
      { clusterId: "cluster-1", goal: "g", memberNoteSlugs: ["notes/a"] },
      1_000,
    );

    addMemberNote("cluster-1", "notes/b", 2_000);
    expect(getCandidate("cluster-1")?.memberNoteSlugs).toEqual([
      "notes/a",
      "notes/b",
    ]);
    expect(getCandidate("cluster-1")?.updatedAt).toBe(2_000);

    // Re-adding an existing slug is a no-op (set semantics, no updated_at bump).
    addMemberNote("cluster-1", "notes/a", 3_000);
    expect(getCandidate("cluster-1")?.memberNoteSlugs).toEqual([
      "notes/a",
      "notes/b",
    ]);
    expect(getCandidate("cluster-1")?.updatedAt).toBe(2_000);

    // Unknown cluster: no row is created.
    addMemberNote("cluster-unknown", "notes/x", 4_000);
    expect(getCandidate("cluster-unknown")).toBeNull();
  });
});

describe("migration", () => {
  test("is idempotent — running twice leaves a usable table", () => {
    // makeDb() already ran the migration once; run it again.
    createProcCandidatesTable(testDb);

    upsertCandidate({ clusterId: "cluster-1", goal: "g" }, 1_000);
    expect(getCandidate("cluster-1")?.goal).toBe("g");
  });
});
