/**
 * Tests for the default compaction plugin (`defaultCompact`).
 *
 * The agent loop calls {@link defaultCompact} directly with a
 * {@link CompactionContext} rather than routing through a middleware pipeline.
 * These tests assert that the default implementation resolves the
 * conversation's {@link ContextWindowManager} from the compaction store and
 * forwards the request's conversational options verbatim. The orchestrator
 * integration path (conversation-agent-loop) is exercised by
 * `conversation-agent-loop-overflow.test.ts`.
 */

import { describe, expect, mock, test } from "bun:test";

// `defaultCompact` resolves the manager from the per-conversation compaction
// store. Register each test's canned stub in a map the mocked store reads from.
const fakeContextWindowManagers = new Map<string, unknown>();
mock.module("../plugins/defaults/compaction/manager-store.js", () => ({
  createContextWindowManager: () => undefined,
  getContextWindowManager: (conversationId: string) =>
    fakeContextWindowManagers.get(conversationId),
  disposeContextWindowManager: (conversationId: string) => {
    fakeContextWindowManagers.delete(conversationId);
  },
}));

const { defaultCompact } =
  await import("../plugins/defaults/compaction/compact.js");

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

/** Register a stub manager under a conversation id and return its recorder. */
function registerManager(
  conversationId: string,
  result: ContextWindowResultShape,
) {
  const observed: {
    messages: unknown;
    signal: unknown;
    options: unknown;
  }[] = [];
  fakeContextWindowManagers.set(conversationId, {
    maybeCompact: async (
      messages: unknown,
      signal: unknown,
      options: unknown,
    ) => {
      observed.push({ messages, signal, options });
      return result;
    },
  });
  return observed;
}

describe("defaultCompact", () => {
  test("delegates to the manager and returns its result unchanged", async () => {
    // GIVEN a manager whose maybeCompact records its arguments
    const expected = makeResult({
      summaryText: "manager-summary",
      compactedMessages: 7,
    });
    const observed = registerManager("conv-delegates", expected);
    const messages = [{ role: "user", content: "hi" }] as never;
    const signal = new AbortController().signal;

    // WHEN defaultCompact runs with those messages and a signal
    const result = (await defaultCompact({
      conversationId: "conv-delegates",
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
    const observed = registerManager("conv-options", makeResult());

    // WHEN defaultCompact runs with force/profile/trust options
    await defaultCompact({
      conversationId: "conv-options",
      messages: [] as never,
      force: true,
      overrideProfile: "fast-profile",
      precomputedEstimate: 1234,
      minKeepRecentUserTurns: 0,
      actorTrustClass: "guardian",
    });

    // THEN the manager received exactly those options, and the conversation id,
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
