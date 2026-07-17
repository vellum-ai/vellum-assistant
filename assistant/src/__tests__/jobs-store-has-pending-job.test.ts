import { beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import { getMemoryDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  enqueueMemoryJob,
  hasPendingJobOfType,
} from "../persistence/jobs-store.js";
import { memoryJobs } from "../persistence/schema/index.js";

function setStatus(id: string, status: string): void {
  getMemoryDb()!
    .update(memoryJobs)
    .set({ status })
    .where(eq(memoryJobs.id, id))
    .run();
}

describe("hasPendingJobOfType", () => {
  beforeAll(async () => {
    await initializeDb();
  });

  beforeEach(() => {
    getMemoryDb()!.run("DELETE FROM memory_jobs");
  });

  test("false on an empty queue", () => {
    expect(hasPendingJobOfType("memory_v2_reembed")).toBe(false);
  });

  test("true when a pending job of the type exists", () => {
    enqueueMemoryJob("memory_v2_reembed", {});
    expect(hasPendingJobOfType("memory_v2_reembed")).toBe(true);
  });

  test("false when the only job of the type is running", () => {
    // The pending/running distinction is the point of this helper: a running
    // job may have snapshotted state before the caller's writes, so it must
    // not suppress a fresh enqueue (contrast `hasActiveJobOfType`).
    const id = enqueueMemoryJob("memory_v2_reembed", {});
    setStatus(id, "running");
    expect(hasPendingJobOfType("memory_v2_reembed")).toBe(false);
  });

  test("false for completed and failed rows", () => {
    setStatus(enqueueMemoryJob("memory_v2_reembed", {}), "completed");
    setStatus(enqueueMemoryJob("memory_v2_reembed", {}), "failed");
    expect(hasPendingJobOfType("memory_v2_reembed")).toBe(false);
  });

  test("scoped to the queried type", () => {
    enqueueMemoryJob("memory_v3_maintain", {});
    expect(hasPendingJobOfType("memory_v2_reembed")).toBe(false);
    expect(hasPendingJobOfType("memory_v3_maintain")).toBe(true);
  });
});
