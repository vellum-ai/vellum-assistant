/**
 * Tests for the default compaction plugin (`defaultCompact`).
 *
 * The agent loop calls {@link defaultCompact} directly with a
 * {@link CompactionContext} rather than routing through a middleware pipeline.
 * These tests assert that the default implementation delegates to the
 * supplied {@link ContextWindowManager} and forwards the request's
 * conversational options verbatim. The orchestrator integration path
 * (conversation-agent-loop) is exercised by
 * `conversation-agent-loop-overflow.test.ts`.
 */

import { describe, expect, test } from "bun:test";

import {
  type CompactionContext,
  defaultCompact,
} from "../plugins/defaults/compaction/compact.js";

type ContextWindowResultShape = {
  compacted: boolean;
  summaryText: string;
  messages: unknown[];
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  compactedPersistedMessages: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
  reason?: string;
};

function makeResult(
  overrides: Partial<ContextWindowResultShape> = {},
): ContextWindowResultShape {
  return {
    compacted: true,
    summaryText: "default-summary",
    messages: [],
    previousEstimatedInputTokens: 1000,
    estimatedInputTokens: 100,
    maxInputTokens: 100000,
    thresholdTokens: 80000,
    compactedMessages: 3,
    compactedPersistedMessages: 3,
    summaryCalls: 1,
    summaryInputTokens: 500,
    summaryOutputTokens: 120,
    summaryModel: "default-model",
    ...overrides,
  };
}

function makeManager(result: ContextWindowResultShape) {
  const observed: {
    messages: unknown;
    signal: unknown;
    options: unknown;
  }[] = [];
  const manager = {
    maybeCompact: async (
      messages: unknown,
      signal: unknown,
      options: unknown,
    ) => {
      observed.push({ messages, signal, options });
      return result;
    },
  } as unknown as CompactionContext["manager"];
  return { manager, observed };
}

describe("defaultCompact", () => {
  test("delegates to the manager and returns its result unchanged", async () => {
    // GIVEN a manager whose maybeCompact records its arguments
    const expected = makeResult({
      summaryText: "manager-summary",
      compactedMessages: 7,
    });
    const { manager, observed } = makeManager(expected);
    const messages = [{ role: "user", content: "hi" }] as never;
    const signal = new AbortController().signal;

    // WHEN defaultCompact runs with those messages and a signal
    const result = (await defaultCompact({
      manager,
      messages,
      signal,
    })) as unknown as ContextWindowResultShape;

    // THEN the manager saw the same messages and signal
    expect(observed).toHaveLength(1);
    expect(observed[0]!.messages).toBe(messages);
    expect(observed[0]!.signal).toBe(signal);

    // AND the returned result is the manager's object, unmodified
    expect(result).toBe(expected);
    expect(result.summaryText).toBe("manager-summary");
    expect(result.compactedMessages).toBe(7);
  });

  test("forwards the request's compaction options to the manager", async () => {
    // GIVEN a manager and a fully-populated compaction context
    const { manager, observed } = makeManager(makeResult());

    // WHEN defaultCompact runs with force/profile/trust options
    await defaultCompact({
      manager,
      messages: [] as never,
      force: true,
      overrideProfile: "fast-profile",
      precomputedEstimate: 1234,
      minKeepRecentUserTurns: 0,
      actorTrustClass: "guardian",
    });

    // THEN the manager received exactly those options, and the manager,
    // messages, and signal are not leaked into the options bag
    expect(observed).toHaveLength(1);
    expect(observed[0]!.options).toEqual({
      force: true,
      overrideProfile: "fast-profile",
      precomputedEstimate: 1234,
      minKeepRecentUserTurns: 0,
      actorTrustClass: "guardian",
    });
  });
});
