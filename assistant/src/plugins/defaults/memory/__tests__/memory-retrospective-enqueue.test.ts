import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mock state — reset between tests.
// ---------------------------------------------------------------------------

let sourceTag: string | null = null;
let convType = "standard";
let convSource = "user";
const upsertCalls: Array<{
  payload: { conversationId: string };
  runAfter: number;
}> = [];
let cfgRequireUserActivity = true;
let cfgRetrospectiveEnabled = true;
let cfgThrows = false;
let mockStateRow: {
  conversationId: string;
  lastProcessedMessageId: string;
  lastRunAt: number;
  rememberedLog: string[];
} | null = null;
let tailQualifies = true;
let gateProbeThrows = false;
let gateProbeCalls: Array<{
  conversationId: string;
  afterMessageId: string | null;
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
  },
}));

mock.module("../../../../config/loader.js", () => ({
  getConfig: () => {
    if (cfgThrows) {
      throw new Error("config unavailable");
    }
    return {
      memory: {
        retrospective: {
          enabled: cfgRetrospectiveEnabled,
          requireUserActivity: cfgRequireUserActivity,
        },
      },
    };
  },
}));

mock.module("../memory-retrospective-state.js", () => ({
  getRetrospectiveState: (_id: string) => mockStateRow,
}));

mock.module("../memory-retrospective-accounting.js", () => ({
  hasQualifyingUserMessageAfter: (
    conversationId: string,
    afterMessageId: string | null,
  ) => {
    gateProbeCalls.push({ conversationId, afterMessageId });
    if (gateProbeThrows) {
      throw new Error("messages table unavailable");
    }
    return tailQualifies;
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
    upsertCalls.length = 0;
    cfgRequireUserActivity = true;
    cfgRetrospectiveEnabled = true;
    cfgThrows = false;
    mockStateRow = null;
    tailQualifies = true;
    gateProbeThrows = false;
    gateProbeCalls = [];
  });

  test("standard source — interval trigger enqueues with runAfter ≈ now", () => {
    const before = Date.now();
    const result = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    const after = Date.now();

    expect(result).toBe(true);
    expect(upsertCalls).toHaveLength(1);
    const call = upsertCalls[0]!;
    expect(call.payload).toEqual({ conversationId: "c1" });
    expect(call.runAfter).toBeGreaterThanOrEqual(before);
    expect(call.runAfter).toBeLessThanOrEqual(after);
  });

  test("enabled=false declines every trigger before any other gate", () => {
    cfgRetrospectiveEnabled = false;

    for (const trigger of [
      "interval",
      "message_count",
      "compaction",
      "sweep",
    ] as const) {
      expect(
        enqueueMemoryRetrospectiveIfEnabled({ conversationId: "c1", trigger }),
      ).toBe(false);
    }

    expect(upsertCalls).toHaveLength(0);
    // The kill switch short-circuits ahead of the user-activity probe, so a
    // disabled retrospective costs no per-conversation message scan.
    expect(gateProbeCalls).toHaveLength(0);
  });

  test("unreadable config: the kill switch fails closed", () => {
    cfgThrows = true;
    const result = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });

    expect(result).toBe(false);
    expect(upsertCalls).toHaveLength(0);
  });

  test("assistant-only tail — user-activity gate skips the enqueue", () => {
    tailQualifies = false;
    const result = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });

    expect(result).toBe(false);
    expect(upsertCalls).toHaveLength(0);
  });

  test("requireUserActivity=false — assistant-only tail still enqueues", () => {
    cfgRequireUserActivity = false;
    tailQualifies = false;
    const result = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });

    expect(result).toBe(true);
    expect(upsertCalls).toHaveLength(1);
    expect(gateProbeCalls).toHaveLength(0);
  });

  test("gate probes the tail from the state row's cursor", () => {
    mockStateRow = {
      conversationId: "c1",
      lastProcessedMessageId: "m9",
      lastRunAt: 1,
      rememberedLog: [],
    };
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "sweep",
    });

    expect(gateProbeCalls).toEqual([
      { conversationId: "c1", afterMessageId: "m9" },
    ]);
  });

  test("an unevaluable gate fails open — the enqueue proceeds", () => {
    gateProbeThrows = true;
    const result = enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });

    expect(result).toBe(true);
    expect(upsertCalls).toHaveLength(1);
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

  test("scheduled conversation — skips enqueue", () => {
    convType = "scheduled";
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    expect(upsertCalls).toHaveLength(0);
  });

  test("memory_v2_consolidation source — skips enqueue", () => {
    convType = "background";
    convSource = "memory_v2_consolidation";
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
    expect(upsertCalls).toHaveLength(0);
  });

  test("heartbeat (background) source — still enqueues", () => {
    convType = "background";
    convSource = "heartbeat";
    enqueueMemoryRetrospectiveIfEnabled({
      conversationId: "c1",
      trigger: "interval",
    });
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
    cfgRequireUserActivity = true;
    tailQualifies = true;
    gateProbeThrows = false;
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
