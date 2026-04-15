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

let flagEnabled = true;
let isAuto = false;
let conversationType: "standard" | "private" = "standard";
let configValue: { analysis?: { idleTimeoutMs?: number } } = {
  analysis: { idleTimeoutMs: 600_000 },
};
let getConfigThrows = false;

const enqueueCalls: Array<{
  type: string;
  payload: Record<string, unknown>;
  runAfter?: number;
}> = [];
const debouncedCalls: Array<{
  type: string;
  payload: { conversationId: string; triggerGroup: "immediate" | "debounced" };
  runAfter: number;
}> = [];

mock.module("../../config/loader.js", () => ({
  getConfig: () => {
    if (getConfigThrows) throw new Error("boom");
    return configValue;
  },
}));

mock.module("../../config/assistant-feature-flags.js", () => ({
  isAssistantFeatureFlagEnabled: (_key: string, _config: unknown) =>
    flagEnabled,
}));

mock.module("../auto-analysis-guard.js", () => ({
  AUTO_ANALYSIS_SOURCE: "auto-analysis",
  isAutoAnalysisConversation: (_conversationId: string) => isAuto,
}));

mock.module("../conversation-crud.js", () => ({
  getConversationType: (_conversationId: string) => conversationType,
}));

mock.module("../jobs-store.js", () => ({
  enqueueMemoryJob: (
    type: string,
    payload: Record<string, unknown>,
    runAfter?: number,
  ) => {
    enqueueCalls.push({ type, payload, runAfter });
    return "job-id";
  },
  upsertAutoAnalysisJob: (
    payload: {
      conversationId: string;
      triggerGroup: "immediate" | "debounced";
    },
    runAfter: number,
  ) => {
    debouncedCalls.push({
      type: "conversation_analyze",
      payload,
      runAfter,
    });
  },
}));

mock.module("../../runtime/actor-trust-resolver.js", () => ({
  isUntrustedTrustClass: (trustClass: string | undefined) =>
    trustClass === "unknown" || trustClass === "untrusted",
}));

import {
  enqueueAutoAnalysisIfEnabled,
  enqueueAutoAnalysisOnCompaction,
} from "../auto-analysis-enqueue.js";

describe("enqueueAutoAnalysisIfEnabled", () => {
  beforeEach(() => {
    flagEnabled = true;
    isAuto = false;
    conversationType = "standard";
    getConfigThrows = false;
    configValue = { analysis: { idleTimeoutMs: 600_000 } };
    enqueueCalls.length = 0;
    debouncedCalls.length = 0;
  });

  test("flag off — no job is enqueued for any trigger", () => {
    flagEnabled = false;

    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "batch" });
    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "idle" });
    enqueueAutoAnalysisIfEnabled({
      conversationId: "c1",
      trigger: "lifecycle",
    });

    expect(enqueueCalls).toHaveLength(0);
    expect(debouncedCalls).toHaveLength(0);
  });

  test("flag on, trigger = 'batch', normal source — upsertDebouncedJob called with runAfter ≈ now", () => {
    const before = Date.now();

    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "batch" });

    const after = Date.now();

    expect(debouncedCalls).toHaveLength(1);
    expect(debouncedCalls[0]!.type).toBe("conversation_analyze");
    expect(debouncedCalls[0]!.payload).toEqual({
      conversationId: "c1",
      triggerGroup: "immediate",
    });
    // "batch" fires immediately (no debounce), so runAfter ≈ now. The
    // "immediate" triggerGroup keeps this row from coalescing with any
    // "debounced" (idle/lifecycle) row — an idle enqueue cannot push
    // this runAfter into the future.
    expect(debouncedCalls[0]!.runAfter).toBeGreaterThanOrEqual(before);
    expect(debouncedCalls[0]!.runAfter).toBeLessThanOrEqual(after);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("flag on, trigger = 'idle', normal source — upsertAutoAnalysisJob called with runAfter ≈ now + idleTimeoutMs", () => {
    configValue = { analysis: { idleTimeoutMs: 600_000 } };
    const before = Date.now();

    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "idle" });

    const after = Date.now();

    expect(debouncedCalls).toHaveLength(1);
    expect(debouncedCalls[0]!.type).toBe("conversation_analyze");
    expect(debouncedCalls[0]!.payload).toEqual({
      conversationId: "c1",
      triggerGroup: "debounced",
    });
    expect(debouncedCalls[0]!.runAfter).toBeGreaterThanOrEqual(
      before + 600_000,
    );
    expect(debouncedCalls[0]!.runAfter).toBeLessThanOrEqual(after + 600_000);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("flag on, trigger = 'lifecycle', normal source — upsertAutoAnalysisJob called (same as idle)", () => {
    configValue = { analysis: { idleTimeoutMs: 600_000 } };
    const before = Date.now();

    enqueueAutoAnalysisIfEnabled({
      conversationId: "c1",
      trigger: "lifecycle",
    });

    const after = Date.now();

    expect(debouncedCalls).toHaveLength(1);
    expect(debouncedCalls[0]!.type).toBe("conversation_analyze");
    expect(debouncedCalls[0]!.payload).toEqual({
      conversationId: "c1",
      triggerGroup: "debounced",
    });
    expect(debouncedCalls[0]!.runAfter).toBeGreaterThanOrEqual(
      before + 600_000,
    );
    expect(debouncedCalls[0]!.runAfter).toBeLessThanOrEqual(after + 600_000);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("flag on, source is auto-analysis — no job is enqueued", () => {
    isAuto = true;

    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "batch" });
    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "idle" });
    enqueueAutoAnalysisIfEnabled({
      conversationId: "c1",
      trigger: "lifecycle",
    });

    expect(enqueueCalls).toHaveLength(0);
    expect(debouncedCalls).toHaveLength(0);
  });

  test("flag on, source is private — no job is enqueued for any trigger", () => {
    // `analyzeConversation` rejects private conversations with FORBIDDEN, so
    // enqueueing a job for one is guaranteed to fail. Skip silently instead
    // so we don't create queue/log churn on every private-chat eviction.
    conversationType = "private";

    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "batch" });
    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "idle" });
    enqueueAutoAnalysisIfEnabled({
      conversationId: "c1",
      trigger: "lifecycle",
    });

    expect(enqueueCalls).toHaveLength(0);
    expect(debouncedCalls).toHaveLength(0);
  });

  test("getConfig throws — skips silently without enqueueing", () => {
    getConfigThrows = true;

    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "batch" });
    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "idle" });

    expect(enqueueCalls).toHaveLength(0);
    expect(debouncedCalls).toHaveLength(0);
  });

  test("uses fallback idleTimeoutMs (600_000) when config.analysis is absent", () => {
    // Simulate an older config that doesn't declare `analysis` yet —
    // `config.analysis?.idleTimeoutMs ?? 600_000` should take the fallback.
    configValue = {};
    const before = Date.now();

    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "idle" });

    const after = Date.now();

    expect(debouncedCalls).toHaveLength(1);
    expect(debouncedCalls[0]!.runAfter).toBeGreaterThanOrEqual(
      before + 600_000,
    );
    expect(debouncedCalls[0]!.runAfter).toBeLessThanOrEqual(after + 600_000);
  });

  test("respects a custom idleTimeoutMs from config", () => {
    configValue = { analysis: { idleTimeoutMs: 1_000 } };
    const before = Date.now();

    enqueueAutoAnalysisIfEnabled({
      conversationId: "c1",
      trigger: "lifecycle",
    });

    const after = Date.now();

    expect(debouncedCalls).toHaveLength(1);
    expect(debouncedCalls[0]!.runAfter).toBeGreaterThanOrEqual(before + 1_000);
    expect(debouncedCalls[0]!.runAfter).toBeLessThanOrEqual(after + 1_000);
  });

  test("flag on, trigger = 'compaction', normal source — fires immediately like 'batch'", () => {
    const before = Date.now();

    enqueueAutoAnalysisIfEnabled({
      conversationId: "c1",
      trigger: "compaction",
    });

    const after = Date.now();

    expect(debouncedCalls).toHaveLength(1);
    expect(debouncedCalls[0]!.type).toBe("conversation_analyze");
    expect(debouncedCalls[0]!.payload).toEqual({
      conversationId: "c1",
      triggerGroup: "immediate",
    });
    // "compaction" fires immediately (runAfter ≈ now) so the reflective
    // agent runs before the narrowed context window pushes more detail out.
    expect(debouncedCalls[0]!.runAfter).toBeGreaterThanOrEqual(before);
    expect(debouncedCalls[0]!.runAfter).toBeLessThanOrEqual(after);
    expect(enqueueCalls).toHaveLength(0);
  });
});

describe("enqueueAutoAnalysisOnCompaction", () => {
  beforeEach(() => {
    flagEnabled = true;
    isAuto = false;
    conversationType = "standard";
    getConfigThrows = false;
    configValue = { analysis: { idleTimeoutMs: 600_000 } };
    enqueueCalls.length = 0;
    debouncedCalls.length = 0;
  });

  test("guardian trust class — enqueues compaction-triggered job immediately", () => {
    const before = Date.now();

    enqueueAutoAnalysisOnCompaction("c1", "guardian");

    const after = Date.now();

    expect(debouncedCalls).toHaveLength(1);
    expect(debouncedCalls[0]!.type).toBe("conversation_analyze");
    expect(debouncedCalls[0]!.payload).toEqual({
      conversationId: "c1",
      triggerGroup: "immediate",
    });
    expect(debouncedCalls[0]!.runAfter).toBeGreaterThanOrEqual(before);
    expect(debouncedCalls[0]!.runAfter).toBeLessThanOrEqual(after);
  });

  test("undefined trust class (treated as guardian for internal call paths) — enqueues", () => {
    enqueueAutoAnalysisOnCompaction("c1", undefined);

    expect(debouncedCalls).toHaveLength(1);
  });

  test("unknown trust class — skips (mirrors memory-extraction trust boundary)", () => {
    enqueueAutoAnalysisOnCompaction("c1", "unknown");

    expect(enqueueCalls).toHaveLength(0);
    expect(debouncedCalls).toHaveLength(0);
  });

  test("trusted_contact trust class — enqueues (not untrusted)", () => {
    // trusted_contact is not in the untrusted set per
    // isUntrustedTrustClass, so compaction-triggered analysis still fires.
    enqueueAutoAnalysisOnCompaction("c1", "trusted_contact");

    expect(debouncedCalls).toHaveLength(1);
  });

  test("guardian trust but flag off — helper still gates via enqueueAutoAnalysisIfEnabled", () => {
    flagEnabled = false;

    enqueueAutoAnalysisOnCompaction("c1", "guardian");

    expect(enqueueCalls).toHaveLength(0);
    expect(debouncedCalls).toHaveLength(0);
  });

  test("guardian trust but source is auto-analysis — helper skips via recursion guard", () => {
    isAuto = true;

    enqueueAutoAnalysisOnCompaction("c1", "guardian");

    expect(enqueueCalls).toHaveLength(0);
    expect(debouncedCalls).toHaveLength(0);
  });
});
