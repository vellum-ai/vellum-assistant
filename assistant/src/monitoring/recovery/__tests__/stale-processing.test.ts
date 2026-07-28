import { rmSync } from "node:fs";
import { beforeEach, describe, expect, test } from "bun:test";

import {
  createConversation,
  incrementProcessingResumeAttempts,
  setConversationProcessingStartedAt,
} from "../../../persistence/conversation-crud.js";
import { getDb, getSqliteFrom } from "../../../persistence/db-connection.js";
import { initializeDb } from "../../../persistence/db-init.js";
import {
  getDaemonBootTimePath,
  recordDaemonBootTime,
} from "../../daemon-boot-time.js";
import { clearStaleProcessing } from "../stale-processing.js";

await initializeDb();

function readRow(id: string): {
  processing_started_at: number | null;
  processing_resume_attempts: number;
} {
  const row = getSqliteFrom(getDb())
    .query(
      `SELECT processing_started_at, processing_resume_attempts
       FROM conversations WHERE id = ?`,
    )
    .get(id) as {
    processing_started_at: number | null;
    processing_resume_attempts: number;
  } | null;
  if (!row) {
    throw new Error(`conversation row missing: ${id}`);
  }
  return row;
}

describe("clearStaleProcessing", () => {
  beforeEach(() => {
    getDb().run("DELETE FROM messages");
    getDb().run("DELETE FROM conversations");
    rmSync(getDaemonBootTimePath(), { force: true });
  });

  test("clears flags set before boot but leaves live-turn flags set after boot", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    // A flag from the previous process (before this boot) is stale.
    createConversation({ id: "conv-stale" });
    setConversationProcessingStartedAt("conv-stale", bootTime - 5_000);
    // A flag from a live turn in the current process (at/after boot) is not.
    createConversation({ id: "conv-live" });
    setConversationProcessingStartedAt("conv-live", bootTime + 5_000);
    createConversation({ id: "conv-idle" });

    clearStaleProcessing();

    expect(readRow("conv-stale").processing_started_at).toBeNull();
    expect(readRow("conv-live").processing_started_at).toBe(bootTime + 5_000);
    expect(readRow("conv-idle").processing_started_at).toBeNull();
  });

  test("preserves the resume-attempt counter so the cap holds across boots", () => {
    const bootTime = Date.now();
    recordDaemonBootTime(bootTime);

    createConversation({ id: "conv-stale" });
    setConversationProcessingStartedAt("conv-stale", bootTime - 5_000);
    incrementProcessingResumeAttempts("conv-stale");
    incrementProcessingResumeAttempts("conv-stale");

    clearStaleProcessing();

    expect(readRow("conv-stale").processing_started_at).toBeNull();
    expect(readRow("conv-stale").processing_resume_attempts).toBe(2);
  });

  test("skips clearing when the daemon boot time is unavailable", () => {
    // No recordDaemonBootTime() call — the fence is unknown, so a stale flag
    // could be indistinguishable from a live turn's and must be left alone.
    const startedAt = Date.now() - 5_000;
    createConversation({ id: "conv-stale" });
    setConversationProcessingStartedAt("conv-stale", startedAt);

    clearStaleProcessing();

    expect(readRow("conv-stale").processing_started_at).toBe(startedAt);
  });
});
