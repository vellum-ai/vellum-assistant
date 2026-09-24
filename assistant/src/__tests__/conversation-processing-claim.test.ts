/**
 * The persisted processing claim is the only lock two processes share. A
 * second process must find a live claim held, take over a dead or legacy one,
 * never clear a claim it does not own, and see a missing row as nothing to
 * hold. Liveness is injected so the tests need no second process.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import {
  claimConversationProcessing,
  clearConversationProcessing,
  createConversation,
  isConversationHeldByOtherProcess,
  setConversationProcessingStartedAt,
} from "../persistence/conversation-crud.js";
import { getDb, getSqliteFrom } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  PROCESSING_CLAIM_MAX_AGE_MS,
  ProcessingHeldElsewhereError,
} from "../persistence/processing-claim.js";

await initializeDb();

const DAEMON = 1_000;
const WORKER = 2_000;
const alive = (pid: number) => pid === DAEMON || pid === WORKER;

function readRow(id: string): {
  processing_started_at: number | null;
  processing_pid: number | null;
} {
  return getSqliteFrom(getDb())
    .query(
      `SELECT processing_started_at, processing_pid FROM conversations WHERE id = ?`,
    )
    .get(id) as {
    processing_started_at: number | null;
    processing_pid: number | null;
  };
}

beforeEach(() => {
  getDb().run("DELETE FROM messages");
  getDb().run("DELETE FROM conversations");
  createConversation({ id: "conv" });
});

describe("claimConversationProcessing", () => {
  test("a free row is claimed and stamped with the holder's pid", () => {
    // GIVEN an idle conversation
    // WHEN the daemon claims it
    const result = claimConversationProcessing("conv", 1_000, DAEMON, alive);
    // THEN the row names the daemon
    expect(result).toEqual({ claimed: true });
    expect(readRow("conv")).toEqual({
      processing_started_at: 1_000,
      processing_pid: DAEMON,
    });
  });

  test("a claim held by another live process is refused", () => {
    // GIVEN the daemon is mid-turn
    claimConversationProcessing("conv", 1_000, DAEMON, alive);
    // WHEN the schedule worker tries to start a wake on the same conversation
    const result = claimConversationProcessing("conv", 2_000, WORKER, alive);
    // THEN it is told who holds it, and the row is unchanged
    expect(result).toEqual({
      claimed: false,
      heldByPid: DAEMON,
      heldSince: 1_000,
    });
    expect(readRow("conv").processing_pid).toBe(DAEMON);
  });

  test("the holder can re-claim its own row", () => {
    // GIVEN the daemon holds the claim
    claimConversationProcessing("conv", 1_000, DAEMON, alive);
    // WHEN the same process claims again (its in-memory flag orders its turns)
    const result = claimConversationProcessing("conv", 3_000, DAEMON, alive);
    // THEN the claim is refreshed
    expect(result).toEqual({ claimed: true });
    expect(readRow("conv").processing_started_at).toBe(3_000);
  });

  test("a claim whose holder is dead is taken over", () => {
    // GIVEN a worker claimed and then crashed
    claimConversationProcessing("conv", 1_000, WORKER, alive);
    const workerDied = (pid: number) => pid === DAEMON;
    // WHEN the daemon claims
    const result = claimConversationProcessing(
      "conv",
      2_000,
      DAEMON,
      workerDied,
    );
    // THEN it wins
    expect(result).toEqual({ claimed: true });
    expect(readRow("conv").processing_pid).toBe(DAEMON);
  });

  test("a legacy claim with no pid is taken over", () => {
    // GIVEN a row stamped by a version that knew no pid
    getSqliteFrom(getDb()).run(
      "UPDATE conversations SET processing_started_at = 1000, processing_pid = NULL WHERE id = 'conv'",
    );
    // WHEN a process claims
    // THEN it wins
    expect(claimConversationProcessing("conv", 2_000, DAEMON, alive)).toEqual({
      claimed: true,
    });
  });

  test("a claim older than the lease ceiling is taken over even if the pid is alive", () => {
    // GIVEN a claim whose pid was recycled onto a live, unrelated process
    claimConversationProcessing("conv", 1_000, WORKER, alive);
    // WHEN the daemon claims after the ceiling
    const later = 1_000 + PROCESSING_CLAIM_MAX_AGE_MS + 1;
    // THEN it wins
    expect(claimConversationProcessing("conv", later, DAEMON, alive)).toEqual({
      claimed: true,
    });
  });

  test("a missing row claims nothing and is not an error", () => {
    expect(claimConversationProcessing("ghost", 1_000, DAEMON, alive)).toEqual({
      claimed: true,
    });
  });
});

describe("clearConversationProcessing", () => {
  test("only the holder's own claim is cleared", () => {
    // GIVEN the daemon holds the claim
    claimConversationProcessing("conv", 1_000, DAEMON, alive);
    // WHEN a worker's late clear arrives
    // THEN the daemon's turn stays marked
    expect(clearConversationProcessing("conv", WORKER)).toBe(false);
    expect(readRow("conv").processing_pid).toBe(DAEMON);
    // AND the daemon's own clear releases it
    expect(clearConversationProcessing("conv", DAEMON)).toBe(true);
    expect(readRow("conv")).toEqual({
      processing_started_at: null,
      processing_pid: null,
    });
  });
});

describe("setConversationProcessingStartedAt", () => {
  test("throws when another live process holds the claim", () => {
    // GIVEN a live claim by this process's pid would not conflict, so the
    // row is stamped with a pid that is alive: this process's own parent.
    claimConversationProcessing("conv", 1_000, process.ppid, () => true);
    // WHEN this process sets processing
    // THEN the claim is refused as held elsewhere
    expect(() => setConversationProcessingStartedAt("conv", 2_000)).toThrow(
      ProcessingHeldElsewhereError,
    );
  });
});

describe("isConversationHeldByOtherProcess", () => {
  test("is true only for a live claim by a different pid", () => {
    expect(isConversationHeldByOtherProcess("conv", DAEMON, alive)).toBe(false);
    claimConversationProcessing("conv", Date.now(), WORKER, alive);
    expect(isConversationHeldByOtherProcess("conv", DAEMON, alive)).toBe(true);
    expect(isConversationHeldByOtherProcess("conv", WORKER, alive)).toBe(false);
    expect(
      isConversationHeldByOtherProcess("conv", DAEMON, (pid) => pid === DAEMON),
    ).toBe(false);
  });
});
