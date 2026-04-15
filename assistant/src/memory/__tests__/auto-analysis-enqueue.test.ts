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
  payload: { conversationId: string };
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

mock.module("../jobs-store.js", () => ({
  enqueueMemoryJob: (
    type: string,
    payload: Record<string, unknown>,
    runAfter?: number,
  ) => {
    enqueueCalls.push({ type, payload, runAfter });
    return "job-id";
  },
  upsertDebouncedJob: (
    type: string,
    payload: { conversationId: string },
    runAfter: number,
  ) => {
    debouncedCalls.push({ type, payload, runAfter });
  },
}));

import { enqueueAutoAnalysisIfEnabled } from "../auto-analysis-enqueue.js";

describe("enqueueAutoAnalysisIfEnabled", () => {
  beforeEach(() => {
    flagEnabled = true;
    isAuto = false;
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
    expect(debouncedCalls[0]!.payload).toEqual({ conversationId: "c1" });
    // "batch" fires immediately (no debounce), so runAfter ≈ now. We use
    // upsertDebouncedJob so two consecutive batch crossings coalesce into
    // a single pending job rather than spawning duplicates.
    expect(debouncedCalls[0]!.runAfter).toBeGreaterThanOrEqual(before);
    expect(debouncedCalls[0]!.runAfter).toBeLessThanOrEqual(after);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("flag on, trigger = 'idle', normal source — upsertDebouncedJob called with runAfter ≈ now + idleTimeoutMs", () => {
    configValue = { analysis: { idleTimeoutMs: 600_000 } };
    const before = Date.now();

    enqueueAutoAnalysisIfEnabled({ conversationId: "c1", trigger: "idle" });

    const after = Date.now();

    expect(debouncedCalls).toHaveLength(1);
    expect(debouncedCalls[0]!.type).toBe("conversation_analyze");
    expect(debouncedCalls[0]!.payload).toEqual({ conversationId: "c1" });
    expect(debouncedCalls[0]!.runAfter).toBeGreaterThanOrEqual(
      before + 600_000,
    );
    expect(debouncedCalls[0]!.runAfter).toBeLessThanOrEqual(after + 600_000);
    expect(enqueueCalls).toHaveLength(0);
  });

  test("flag on, trigger = 'lifecycle', normal source — upsertDebouncedJob called (same as idle)", () => {
    configValue = { analysis: { idleTimeoutMs: 600_000 } };
    const before = Date.now();

    enqueueAutoAnalysisIfEnabled({
      conversationId: "c1",
      trigger: "lifecycle",
    });

    const after = Date.now();

    expect(debouncedCalls).toHaveLength(1);
    expect(debouncedCalls[0]!.type).toBe("conversation_analyze");
    expect(debouncedCalls[0]!.payload).toEqual({ conversationId: "c1" });
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
});
