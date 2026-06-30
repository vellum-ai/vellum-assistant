/**
 * Tests for the stale-processing reaper.
 *
 * - `selectStaleActions` must abort ids newly over the ceiling and force-clear
 *   only those that survived a full interval (present in the prior set), so a
 *   genuinely live turn that clears its own flag after the graceful abort is
 *   never force-cleared.
 * - `runStaleProcessingSweep` must leave flags under the ceiling untouched,
 *   nudge resident over-ceiling turns with an abort on first sight, and on the
 *   next sweep force-clear (in-memory + column) a resident turn that did not
 *   unwind and clear a cold conversation's column directly.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

interface FakeConversation {
  id: string;
  abortCalls: number;
  setProcessingCalls: boolean[];
  _processing: boolean;
  isProcessing(): boolean;
  abort(): void;
  setProcessing(value: boolean): void;
}

const residentConversations = new Map<string, FakeConversation>();

mock.module("./conversation-registry.js", () => ({
  findConversation: (id: string) => residentConversations.get(id),
}));

const {
  createConversation,
  isConversationProcessing,
  setConversationProcessingStartedAt,
} = await import("../persistence/conversation-crud.js");
const { getDb } = await import("../persistence/db-connection.js");
const { initializeDb } = await import("../persistence/db-init.js");
const { selectStaleActions, runStaleProcessingSweep, stopStaleProcessingReaper } =
  await import("./stale-processing-reaper.js");

await initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run(`DELETE FROM messages`);
  db.run(`DELETE FROM conversations`);
}

/**
 * Register a resident fake whose `setProcessing(false)` mirrors the real
 * `Conversation.setProcessing` by nulling the persisted column, so the test
 * reflects the production clear path.
 */
function makeResident(id: string): FakeConversation {
  const fake: FakeConversation = {
    id,
    abortCalls: 0,
    setProcessingCalls: [],
    // A resident conversation registered here is one with a stuck flag, so it
    // starts processing — mirroring the real in-memory `_processing` the
    // hot-path submit gate reads.
    _processing: true,
    isProcessing() {
      return this._processing;
    },
    abort() {
      this.abortCalls++;
    },
    setProcessing(value: boolean) {
      this.setProcessingCalls.push(value);
      this._processing = value;
      setConversationProcessingStartedAt(id, value ? Date.now() : null);
    },
  };
  residentConversations.set(id, fake);
  return fake;
}

const CEILING_MS = 30 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;

describe("selectStaleActions", () => {
  test("aborts newly-stale ids and force-clears those seen last sweep", () => {
    const result = selectStaleActions(["a", "b", "c"], new Set(["b"]));
    expect(result.abort.sort()).toEqual(["a", "c"]);
    expect(result.forceClear).toEqual(["b"]);
    expect([...result.nextSeen].sort()).toEqual(["a", "b", "c"]);
  });

  test("drops ids no longer stale from the carried-forward set", () => {
    // "b" cleared its own flag after last sweep's abort, so it is absent now.
    const result = selectStaleActions(["a"], new Set(["a", "b"]));
    expect(result.forceClear).toEqual(["a"]);
    expect([...result.nextSeen]).toEqual(["a"]);
  });

  test("empty current set carries nothing forward", () => {
    const result = selectStaleActions([], new Set(["a", "b"]));
    expect(result.abort).toEqual([]);
    expect(result.forceClear).toEqual([]);
    expect(result.nextSeen.size).toBe(0);
  });
});

describe("runStaleProcessingSweep", () => {
  beforeEach(() => {
    resetTables();
    residentConversations.clear();
    stopStaleProcessingReaper(); // reset the module-level grace set
  });

  test("leaves a flag under the ceiling untouched", () => {
    const recent = createConversation("recent");
    setConversationProcessingStartedAt(recent.id, Date.now());
    makeResident(recent.id);

    const result = runStaleProcessingSweep({
      ceilingMs: CEILING_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
    });

    expect(result.aborted).toBe(0);
    expect(result.forceCleared).toBe(0);
    expect(isConversationProcessing(recent.id)).toBe(true);
  });

  test("nudges a resident over-ceiling turn with abort, then force-clears if it does not unwind", () => {
    const stuck = createConversation("stuck");
    // Flag set well beyond the ceiling.
    setConversationProcessingStartedAt(stuck.id, Date.now() - CEILING_MS - 1);
    const fake = makeResident(stuck.id);

    // First sweep: graceful abort only; flag intentionally left set.
    const first = runStaleProcessingSweep({
      ceilingMs: CEILING_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
    });
    expect(first.aborted).toBe(1);
    expect(first.forceCleared).toBe(0);
    expect(fake.abortCalls).toBe(1);
    expect(isConversationProcessing(stuck.id)).toBe(true);

    // Second sweep: the turn never unwound, so force-clear in-memory + column.
    const second = runStaleProcessingSweep({
      ceilingMs: CEILING_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
    });
    expect(second.forceCleared).toBe(1);
    expect(fake.setProcessingCalls).toContain(false);
    expect(isConversationProcessing(stuck.id)).toBe(false);
  });

  test("does not force-clear a turn that cleared its own flag after the abort", () => {
    const live = createConversation("live-long-turn");
    setConversationProcessingStartedAt(live.id, Date.now() - CEILING_MS - 1);
    const fake = makeResident(live.id);

    // First sweep aborts; simulate the live loop unwinding via its finally.
    runStaleProcessingSweep({
      ceilingMs: CEILING_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
    });
    expect(fake.abortCalls).toBe(1);
    // The live loop observes the abort and unwinds through its own finally,
    // clearing both the in-memory flag and the column — not via the reaper.
    fake._processing = false;
    setConversationProcessingStartedAt(live.id, null);

    // Second sweep finds nothing stale, so it never force-clears.
    const second = runStaleProcessingSweep({
      ceilingMs: CEILING_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
    });
    expect(second.forceCleared).toBe(0);
    // Only the graceful abort ever ran — never a reaper setProcessing(false).
    expect(fake.setProcessingCalls).toEqual([]);
  });

  test("clears a cold (non-resident) conversation's column on the force-clear pass", () => {
    const cold = createConversation("cold");
    setConversationProcessingStartedAt(cold.id, Date.now() - CEILING_MS - 1);
    // No resident entry: findConversation returns undefined.

    // First sweep: cold conversations have no live loop to abort, so nothing
    // happens, but the id is carried forward.
    const first = runStaleProcessingSweep({
      ceilingMs: CEILING_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
    });
    expect(first.aborted).toBe(0);
    expect(isConversationProcessing(cold.id)).toBe(true);

    // Second sweep: force-clear the column directly.
    const second = runStaleProcessingSweep({
      ceilingMs: CEILING_MS,
      sweepIntervalMs: SWEEP_INTERVAL_MS,
    });
    expect(second.forceCleared).toBe(1);
    expect(isConversationProcessing(cold.id)).toBe(false);
  });
});
