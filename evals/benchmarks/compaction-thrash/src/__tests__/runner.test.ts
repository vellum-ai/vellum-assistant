/**
 * Unit tests for the compaction-thrash per-tick observation logic.
 *
 * These cover the three measurement fixes the benchmark depends on:
 *   1. Compaction passes are counted from the on-the-wire
 *      `assistant_activity_state` event with `reason: "context_compacting"`,
 *      not the phantom top-level `context_compacting` message type.
 *   2. Per-tick cache/token usage prefers egress-jail records (snake_case,
 *      with cache fields) over SSE `usage_update` (no cache fields).
 *   3. `contextWindowTokens` is captured from `usage_update` as a diagnostic.
 *
 * Pure functions only — synthetic events in, observation out. No network,
 * no agent, no daemon.
 */
import { describe, expect, test } from "bun:test";

import type { AgentEvent } from "../../../../src/lib/adapter";
import { countCompactionPasses, observeTick } from "../runner";

/** An `assistant_activity_state` event with the given reason. */
function activityState(reason: string): AgentEvent {
  return {
    message: {
      type: "assistant_activity_state",
      reason,
    },
  };
}

/** A daemon SSE `usage_update` event (camelCase, no cache fields). */
function usageUpdate(fields: {
  inputTokens?: number;
  outputTokens?: number;
  contextWindowTokens?: number;
}): AgentEvent {
  return {
    message: {
      type: "usage_update",
      inputTokens: fields.inputTokens ?? 0,
      outputTokens: fields.outputTokens ?? 0,
      ...(fields.contextWindowTokens !== undefined
        ? { contextWindowTokens: fields.contextWindowTokens }
        : {}),
    },
  };
}

/** An egress-jail usage record (flat snake_case, with cache fields). */
function jailRecord(fields: {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}): Record<string, unknown> {
  return {
    input_tokens: fields.input_tokens ?? 0,
    output_tokens: fields.output_tokens ?? 0,
    cache_creation_input_tokens: fields.cache_creation_input_tokens ?? 0,
    cache_read_input_tokens: fields.cache_read_input_tokens ?? 0,
    model: "claude-opus-4-8",
    recorded_at: "2026-06-12T00:00:00.000Z",
    request_path: "/v1/messages",
  };
}

describe("countCompactionPasses", () => {
  test("counts the on-the-wire activity-state context_compacting marker", () => {
    const events: AgentEvent[] = [
      activityState("message_dequeued"),
      activityState("context_compacting"),
      activityState("message_complete"),
    ];
    expect(countCompactionPasses(events)).toBe(1);
  });

  test("does NOT count the phantom top-level context_compacting if used as a reason on a non-activity event", () => {
    // A `usage_update` (or any non-activity-state event) that happens to
    // carry `reason: "context_compacting"` must not be counted — only the
    // `assistant_activity_state` marker (or the internal type) counts.
    const events: AgentEvent[] = [
      { message: { type: "usage_update", reason: "context_compacting" } },
    ];
    expect(countCompactionPasses(events)).toBe(0);
  });

  test("counts the internal context_compacting message type if it ever reaches the wire", () => {
    const events: AgentEvent[] = [{ message: { type: "context_compacting" } }];
    expect(countCompactionPasses(events)).toBe(1);
  });

  test("ignores compaction_completed (the paired end event)", () => {
    const events: AgentEvent[] = [
      { message: { type: "context_compacting" } },
      { message: { type: "compaction_completed" } },
    ];
    expect(countCompactionPasses(events)).toBe(1);
  });

  test("collapses consecutive same-reason markers into one pass", () => {
    // Defensive: if a future daemon emitted the marker twice back-to-back
    // for the SAME pass, it must still count once.
    const events: AgentEvent[] = [
      activityState("context_compacting"),
      activityState("context_compacting"),
    ];
    expect(countCompactionPasses(events)).toBe(1);
  });

  test("counts two distinct passes separated by other activity", () => {
    const events: AgentEvent[] = [
      activityState("context_compacting"),
      activityState("message_complete"),
      activityState("thinking"),
      activityState("context_compacting"),
      activityState("message_complete"),
    ];
    expect(countCompactionPasses(events)).toBe(2);
  });

  test("zero passes when no compaction occurs", () => {
    const events: AgentEvent[] = [
      activityState("message_dequeued"),
      usageUpdate({ inputTokens: 100 }),
      activityState("message_complete"),
    ];
    expect(countCompactionPasses(events)).toBe(0);
  });
});

describe("observeTick", () => {
  test("prefers egress-jail records for token + cache usage", () => {
    const events: AgentEvent[] = [
      activityState("context_compacting"),
      // SSE usage_update is present but should be IGNORED when jail records
      // exist — these numbers must not leak into the observation.
      usageUpdate({ inputTokens: 999, outputTokens: 999 }),
      activityState("message_complete"),
    ];
    const jailRecords = [
      jailRecord({
        input_tokens: 5000,
        output_tokens: 80,
        cache_creation_input_tokens: 4000,
        cache_read_input_tokens: 1000,
      }),
      jailRecord({
        input_tokens: 6000,
        output_tokens: 40,
        cache_creation_input_tokens: 5500,
        cache_read_input_tokens: 500,
      }),
    ];

    const obs = observeTick(7, "observe", events, jailRecords);

    expect(obs.tick).toBe(7);
    expect(obs.phase).toBe("observe");
    expect(obs.compactionEvents).toBe(1);
    expect(obs.inputTokens).toBe(11000);
    expect(obs.outputTokens).toBe(120);
    expect(obs.cacheCreationInputTokens).toBe(9500);
    expect(obs.cacheReadInputTokens).toBe(1500);
  });

  test("falls back to SSE usage_update when no jail records exist", () => {
    const events: AgentEvent[] = [
      usageUpdate({ inputTokens: 1200, outputTokens: 60 }),
      usageUpdate({ inputTokens: 300, outputTokens: 10 }),
    ];

    const obs = observeTick(3, "seed", events, []);

    expect(obs.inputTokens).toBe(1500);
    expect(obs.outputTokens).toBe(70);
    // No cache fields on the SSE wire → zero.
    expect(obs.cacheCreationInputTokens).toBe(0);
    expect(obs.cacheReadInputTokens).toBe(0);
  });

  test("captures the max contextWindowTokens from usage_update", () => {
    const events: AgentEvent[] = [
      usageUpdate({ inputTokens: 100, contextWindowTokens: 25000 }),
      usageUpdate({ inputTokens: 100, contextWindowTokens: 31000 }),
      usageUpdate({ inputTokens: 100, contextWindowTokens: 28000 }),
    ];

    const obs = observeTick(9, "observe", events, []);

    expect(obs.contextWindowTokens).toBe(31000);
  });

  test("omits contextWindowTokens when no usage_update carries it", () => {
    const events: AgentEvent[] = [activityState("message_complete")];
    const obs = observeTick(1, "seed", events, []);
    expect(obs.contextWindowTokens).toBeUndefined();
  });
});
