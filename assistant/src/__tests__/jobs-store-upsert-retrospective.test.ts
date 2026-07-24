import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { and, eq } from "drizzle-orm";

import { getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  completeMemoryJob,
  upsertMemoryRetrospectiveJob,
} from "../persistence/jobs-store.js";
import { memoryJobs } from "../persistence/schema/index.js";

function pendingRetrospectiveRows(conversationId: string) {
  const db = getMemoryDb()!;
  return db
    .select()
    .from(memoryJobs)
    .where(
      and(
        eq(memoryJobs.type, "memory_retrospective"),
        eq(memoryJobs.status, "pending"),
      ),
    )
    .all()
    .filter((row) => {
      const payload = JSON.parse(row.payload) as { conversationId?: string };
      return payload.conversationId === conversationId;
    });
}

describe("upsertMemoryRetrospectiveJob create-vs-coalesce", () => {
  beforeAll(async () => {
    await initializeDb();
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
  });

  test("reports true and inserts a new pending row on first enqueue", () => {
    const created = upsertMemoryRetrospectiveJob(
      { conversationId: "conv-1" },
      1_000,
    );

    expect(created).toBe(true);
    expect(pendingRetrospectiveRows("conv-1")).toHaveLength(1);
  });

  test("reports false and does NOT insert a second row when a pending job exists", () => {
    expect(
      upsertMemoryRetrospectiveJob({ conversationId: "conv-1" }, 1_000),
    ).toBe(true);

    const coalesced = upsertMemoryRetrospectiveJob(
      { conversationId: "conv-1" },
      2_000,
    );

    expect(coalesced).toBe(false);
    expect(pendingRetrospectiveRows("conv-1")).toHaveLength(1);
  });

  test("coalesce still pulls runAfter earlier (min semantics) and never pushes it out", () => {
    expect(
      upsertMemoryRetrospectiveJob({ conversationId: "conv-1" }, 5_000),
    ).toBe(true);

    // A sooner trigger pulls the pending row's runAfter earlier.
    expect(
      upsertMemoryRetrospectiveJob({ conversationId: "conv-1" }, 3_000),
    ).toBe(false);
    expect(pendingRetrospectiveRows("conv-1")[0]!.runAfter).toBe(3_000);

    // A later trigger never pushes the pending row further out.
    expect(
      upsertMemoryRetrospectiveJob({ conversationId: "conv-1" }, 9_000),
    ).toBe(false);
    expect(pendingRetrospectiveRows("conv-1")[0]!.runAfter).toBe(3_000);
  });

  test("a fresh enqueue after the prior job completes reports true again", () => {
    expect(
      upsertMemoryRetrospectiveJob({ conversationId: "conv-1" }, 1_000),
    ).toBe(true);
    const [pending] = pendingRetrospectiveRows("conv-1");
    completeMemoryJob(pending!.id);

    // No pending row remains, so the next enqueue is a genuine new creation.
    const created = upsertMemoryRetrospectiveJob(
      { conversationId: "conv-1" },
      2_000,
    );

    expect(created).toBe(true);
    expect(pendingRetrospectiveRows("conv-1")).toHaveLength(1);
  });

  test("distinct conversations each create their own pending job", () => {
    expect(
      upsertMemoryRetrospectiveJob({ conversationId: "conv-1" }, 1_000),
    ).toBe(true);
    expect(
      upsertMemoryRetrospectiveJob({ conversationId: "conv-2" }, 1_000),
    ).toBe(true);

    expect(pendingRetrospectiveRows("conv-1")).toHaveLength(1);
    expect(pendingRetrospectiveRows("conv-2")).toHaveLength(1);
  });
});
