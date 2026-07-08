/**
 * Tests for the retention-derived cadence of the scheduled cleanup jobs.
 *
 * `maybeEnqueueScheduledCleanupJobs` enqueues each prune job on a cadence
 * equal to that job's own retention window, and throttles each job
 * independently: LLM-request-log pruning follows `llmRequestLogRetentionMs`,
 * conversation pruning follows `conversationRetentionDays`, and audit-log
 * (`tool_invocations`) pruning follows `auditLog.retentionDays`.
 *
 * The real cleanup-schedule-state module (pure, in-memory, no DB) provides the
 * per-job throttle; only jobs-store's enqueue functions and the logger are
 * mocked so we can observe which jobs were enqueued on each tick.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/types.js";

// ── Mocks (must precede imports of tested module) ──────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let convCalls: Array<number | undefined> = [];
let llmCalls: Array<number | undefined> = [];
let toolCalls: Array<number | undefined> = [];

mock.module("../persistence/jobs-store.js", () => ({
  resetRunningJobsToPending: () => 0,
  claimMemoryJobs: () => [],
  completeMemoryJob: () => {},
  deferMemoryJob: () => "deferred",
  failMemoryJob: () => {},
  failStalledJobs: () => 0,
  enqueuePruneOldConversationsJob: (retentionDays?: number) => {
    convCalls.push(retentionDays);
    return "conv-job";
  },
  enqueuePruneOldLlmRequestLogsJob: (retentionMs?: number) => {
    llmCalls.push(retentionMs);
    return "llm-job";
  },
  enqueuePruneOldToolInvocationsJob: (retentionDays?: number) => {
    toolCalls.push(retentionDays);
    return "tool-job";
  },
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({ memory: { enabled: false } }),
  loadConfig: () => ({ memory: { enabled: false } }),
}));

import { resetCleanupScheduleThrottle } from "../persistence/cleanup-schedule-state.js";
import { maybeEnqueueScheduledCleanupJobs } from "../plugins/defaults/memory/jobs-worker.js";

const HOUR = 60 * 60 * 1000;

// A realistic epoch-ms base. In production `nowMs` is `Date.now()`, which is
// always astronomically larger than any retention window, so after a throttle
// reset (last enqueue = 0) every due job fires on the first tick. Anchoring the
// tests at a real timestamp mirrors that; using 0 would make `now - last` too
// small to clear long retention windows.
const BASE = 1_700_000_000_000;

function makeConfig(opts: {
  enabled?: boolean;
  conversationRetentionDays?: number;
  llmRequestLogRetentionMs?: number | null;
  auditLogRetentionDays?: number;
}): AssistantConfig {
  return {
    memory: {
      cleanup: {
        enabled: opts.enabled ?? true,
        conversationRetentionDays: opts.conversationRetentionDays ?? 0,
        llmRequestLogRetentionMs:
          opts.llmRequestLogRetentionMs === undefined
            ? null
            : opts.llmRequestLogRetentionMs,
      },
    },
    auditLog: { retentionDays: opts.auditLogRetentionDays ?? 0 },
  } as unknown as AssistantConfig;
}

describe("maybeEnqueueScheduledCleanupJobs retention-derived cadence", () => {
  beforeEach(() => {
    convCalls = [];
    llmCalls = [];
    toolCalls = [];
    resetCleanupScheduleThrottle();
  });

  test("LLM-log prune fires once per retention window", () => {
    const config = makeConfig({ llmRequestLogRetentionMs: HOUR });

    // First tick fires immediately (throttle starts at 0).
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(true);
    expect(llmCalls).toEqual([HOUR]);

    // Half a window later: not due, nothing enqueued.
    expect(
      maybeEnqueueScheduledCleanupJobs(config, BASE + 30 * 60 * 1000),
    ).toBe(false);
    expect(llmCalls).toEqual([HOUR]);

    // Just past the full window: due again.
    expect(maybeEnqueueScheduledCleanupJobs(config, BASE + HOUR + 1)).toBe(
      true,
    );
    expect(llmCalls).toEqual([HOUR, HOUR]);
  });

  test("each prune throttles independently on its own retention", () => {
    const config = makeConfig({
      conversationRetentionDays: 1, // 1 day
      llmRequestLogRetentionMs: HOUR, // 1 hour
    });

    // t=0: both due.
    maybeEnqueueScheduledCleanupJobs(config, BASE);
    expect(convCalls).toEqual([1]);
    expect(llmCalls).toEqual([HOUR]);

    // t=2h: LLM window (1h) elapsed, conversation window (1d) has not.
    maybeEnqueueScheduledCleanupJobs(config, BASE + 2 * HOUR);
    expect(convCalls).toEqual([1]);
    expect(llmCalls).toEqual([HOUR, HOUR]);

    // t=25h: conversation window now elapsed too.
    maybeEnqueueScheduledCleanupJobs(config, BASE + 25 * HOUR);
    expect(convCalls).toEqual([1, 1]);
    expect(llmCalls.length).toBe(3);
  });

  test("tool_invocations prune follows auditLog.retentionDays", () => {
    const config = makeConfig({ auditLogRetentionDays: 1 }); // 1 day

    maybeEnqueueScheduledCleanupJobs(config, BASE);
    expect(toolCalls).toEqual([1]);

    // 12h later: within the 1-day window.
    maybeEnqueueScheduledCleanupJobs(config, BASE + 12 * HOUR);
    expect(toolCalls).toEqual([1]);

    // 25h later: past the window.
    maybeEnqueueScheduledCleanupJobs(config, BASE + 25 * HOUR);
    expect(toolCalls).toEqual([1, 1]);
  });

  test("disabled cleanup enqueues nothing", () => {
    const config = makeConfig({
      enabled: false,
      conversationRetentionDays: 1,
      llmRequestLogRetentionMs: HOUR,
      auditLogRetentionDays: 1,
    });

    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(false);
    expect(convCalls).toEqual([]);
    expect(llmCalls).toEqual([]);
    expect(toolCalls).toEqual([]);
  });

  test("null LLM-log retention keeps logs forever (no prune enqueued)", () => {
    const config = makeConfig({ llmRequestLogRetentionMs: null });

    expect(maybeEnqueueScheduledCleanupJobs(config, BASE)).toBe(false);
    expect(llmCalls).toEqual([]);
  });

  test("resetCleanupScheduleThrottle makes every job due on the next tick", () => {
    const config = makeConfig({
      conversationRetentionDays: 30,
      llmRequestLogRetentionMs: HOUR,
      auditLogRetentionDays: 30,
    });

    maybeEnqueueScheduledCleanupJobs(config, BASE);
    expect(convCalls.length).toBe(1);
    expect(llmCalls.length).toBe(1);
    expect(toolCalls.length).toBe(1);

    // Without a reset, a tick a minute later re-enqueues nothing (all windows
    // are far from elapsed).
    maybeEnqueueScheduledCleanupJobs(config, BASE + 60_000);
    expect(convCalls.length).toBe(1);
    expect(llmCalls.length).toBe(1);
    expect(toolCalls.length).toBe(1);

    // A retention-settings change resets the throttle; the very next tick
    // re-enqueues every job regardless of its window.
    resetCleanupScheduleThrottle();
    maybeEnqueueScheduledCleanupJobs(config, BASE + 120_000);
    expect(convCalls.length).toBe(2);
    expect(llmCalls.length).toBe(2);
    expect(toolCalls.length).toBe(2);
  });
});
