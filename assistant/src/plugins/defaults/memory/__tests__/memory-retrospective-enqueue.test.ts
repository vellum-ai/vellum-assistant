import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state — reset between tests.
// ---------------------------------------------------------------------------

let sourceTag: string | null = null;
let convType = "standard";
let convSource = "user";
// Simulates whether the real `upsertMemoryRetrospectiveJob` inserted a NEW row
// (true) or coalesced into an already-pending one (false). The enqueue helper
// must propagate this verbatim so budget-metered callers only count creations.
let upsertCreated = true;
const upsertCalls: Array<{
  payload: { conversationId: string };
  runAfter: number;
}> = [];

mock.module("../../../../persistence/conversation-crud.js", () => ({
  getConversationSource: (_id: string) => sourceTag,
  getConversation: (_id: string) => ({
    conversationType: convType,
    source: convSource,
  }),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../../../../persistence/jobs-store.js", () => ({
  upsertMemoryRetrospectiveJob: (
    payload: { conversationId: string },
    runAfter: number,
  ) => {
    upsertCalls.push({ payload, runAfter });
    return upsertCreated;
  },
}));

import {
  enqueueMemoryRetrospectiveIfEnabled,
  enqueueMemoryRetrospectiveOnCompaction,
  isMemoryRetrospectiveConversation,
} from "../memory-retrospective-enqueue.js";

describe("enqueueMemoryRetrospectiveIfEnabled", () => {
  beforeEach(() => {
    sourceTag = null;
    convType = "standard";
    convSource = "user";
    upsertCreated = true;
    upsertCalls.length = 0;
  });

  test("standard source — interval trigger enqueues with runAfter ≈ now and reports true", () => {
    const before = Date.now();
    const enqueued = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    const after = Date.now();

    expect(enqueued).toBe(true);
    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0]!;
    expect(call.payload).toEqual({ conversationId: "c1" });
    expect(call.runAfter).toBeGreaterThanOrEqual(before);
    expect(call.runAfter).toBeLessThanOrEqual(after);
  });

  test("compaction trigger applies the small debounce", () => {
    const before = Date.now();
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "compaction",
    });

    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0]!;
    expect(call.runAfter).toBeGreaterThan(before + 100);
  });

  test("coalesced upsert (existing pending job) — reports false even for an eligible source", () => {
    // The source is eligible, so the upsert IS attempted, but it coalesces into
    // an already-pending row rather than inserting a new one. The helper must
    // report false so budget-metered callers do not count a run that cannot
    // spawn a second retrospective.
    upsertCreated = false;
    const enqueued = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    expect(enqueued).toBe(false);
    // The upsert still ran (the runAfter-min pull is its responsibility).
    expect(upsertCalls).toHaveLength(1);
  });

  test("recursion guard — source = 'memory-retrospective' skips enqueue and reports false", () => {
    sourceTag = "memory-retrospective";
    const enqueued = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    expect(enqueued).toBe(false);
    expect(upsertCalls).toHaveLength(0);
  });

  test("scheduled conversation — skips enqueue and reports false", () => {
    convType = "scheduled";
    const enqueued = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    expect(enqueued).toBe(false);
    expect(upsertCalls).toHaveLength(0);
  });

  test("memory_v2_consolidation source — skips enqueue and reports false", () => {
    convType = "background";
    convSource = "memory_v2_consolidation";
    const enqueued = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    expect(enqueued).toBe(false);
    expect(upsertCalls).toHaveLength(0);
  });

  test("heartbeat (background) source — still enqueues and reports true", () => {
    convType = "background";
    convSource = "heartbeat";
    const enqueued = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    expect(enqueued).toBe(true);
    expect(upsertCalls).toHaveLength(1);
  });
});

describe("isMemoryRetrospectiveConversation", () => {
  beforeEach(() => {
    sourceTag = null;
  });

  test("returns true only for the matching source tag", () => {
    sourceTag = "memory-retrospective";
    expect(isMemoryRetrospectiveConversation("c1")).toBe(true);
  });

  test("returns false for other source tags", () => {
    sourceTag = "auto-analysis";
    expect(isMemoryRetrospectiveConversation("c1")).toBe(false);
  });

  test("returns false when source is null", () => {
    sourceTag = null;
    expect(isMemoryRetrospectiveConversation("c1")).toBe(false);
  });
});

describe("enqueueMemoryRetrospectiveOnCompaction", () => {
  beforeEach(() => {
    sourceTag = null;
    upsertCalls.length = 0;
  });

  test("untrusted trust class — no enqueue", () => {
    enqueueMemoryRetrospectiveOnCompaction("c1", "unknown");
    enqueueMemoryRetrospectiveOnCompaction("c1", "trusted_contact");
    enqueueMemoryRetrospectiveOnCompaction("c1", undefined);
    expect(upsertCalls).toHaveLength(0);
  });

  test("guardian trust — enqueues with compaction debounce", () => {
    const before = Date.now();
    enqueueMemoryRetrospectiveOnCompaction("c1", "guardian");
    expect(upsertCalls).toHaveLength(1);
    expect(upsertCalls[0]!.runAfter).toBeGreaterThan(before + 100);
  });
});
