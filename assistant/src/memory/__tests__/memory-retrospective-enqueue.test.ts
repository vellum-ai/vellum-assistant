import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// ---------------------------------------------------------------------------
// Mock state — reset between tests.
// ---------------------------------------------------------------------------

let sourceTag: string | null = null;
const upsertCalls: Array<{
  payload: { conversationId: string };
  runAfter: number;
}> = [];

mock.module("../conversation-crud.js", () => ({
  getConversationSource: (_id: string) => sourceTag,
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
}));

mock.module("../jobs-store.js", () => ({
  upsertMemoryRetrospectiveJob: (
    payload: { conversationId: string },
    runAfter: number,
  ) => {
    upsertCalls.push({ payload, runAfter });
  },
}));

mock.module("../../runtime/actor-trust-resolver.js", () => ({
  isUntrustedTrustClass: (trustClass: string | undefined) =>
    trustClass === "trusted_contact" ||
    trustClass === "unknown" ||
    trustClass === undefined,
}));

import {
  enqueueMemoryRetrospectiveIfEnabled,
  enqueueMemoryRetrospectiveOnCompaction,
  isMemoryRetrospectiveConversation,
} from "../memory-retrospective-enqueue.js";

describe("enqueueMemoryRetrospectiveIfEnabled", () => {
  beforeEach(() => {
    sourceTag = null;
    upsertCalls.length = 0;
  });

  test("standard source — interval trigger enqueues with runAfter ≈ now", () => {
    const before = Date.now();
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    const after = Date.now();

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

  test("recursion guard — source = 'memory-retrospective' skips enqueue", () => {
    sourceTag = "memory-retrospective";
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    expect(upsertCalls).toHaveLength(0);
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
