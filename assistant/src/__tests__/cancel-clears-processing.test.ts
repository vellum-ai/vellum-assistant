/**
 * Regression test for the stuck "Thinking…" bug: a user cancel must drive the
 * conversation's processing flag to false even when the in-flight turn never
 * observes the AbortController signal (a wedged agent loop that never reaches
 * its `finally`). The processing flag is the authoritative source for the
 * client thinking indicator, so a latched-true flag pins every client on
 * "Thinking…" indefinitely.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import { cancelGeneration } from "../daemon/handlers/conversations.js";

interface WedgedTurnConversation {
  isProcessing: () => boolean;
  setProcessingCalls: () => boolean[];
  abortCount: () => number;
}

/**
 * Register a conversation whose in-flight turn is wedged: it accepts the abort
 * signal but never unwinds, so it leaves the processing flag untouched. This
 * is the exact condition that latches `processing` true in production.
 */
function registerWedgedTurn(id: string): WedgedTurnConversation {
  let processing = true;
  let abortCount = 0;
  const setProcessingCalls: boolean[] = [];
  const fake = {
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      setProcessingCalls.push(value);
      processing = value;
    },
    abort: () => {
      abortCount += 1;
    },
  };
  setConversation(id, fake as unknown as Conversation);
  return {
    isProcessing: () => processing,
    setProcessingCalls: () => setProcessingCalls,
    abortCount: () => abortCount,
  };
}

describe("cancelGeneration", () => {
  const conversationId = "cancel-clears-processing-test-conversation";

  afterEach(() => {
    deleteConversation(conversationId);
  });

  test("clears the processing flag when the in-flight turn ignores the abort signal", () => {
    // GIVEN a registered conversation that is processing
    // AND whose in-flight turn ignores the abort signal (never clears processing)
    const fake = registerWedgedTurn(conversationId);
    expect(fake.isProcessing()).toBe(true);

    // WHEN the user cancels generation
    const cancelled = cancelGeneration(conversationId);

    // THEN the cancel is acknowledged
    expect(cancelled).toBe(true);
    // AND the abort signal is still raised on the conversation
    expect(fake.abortCount()).toBe(1);
    // AND the processing flag is cleared through setProcessing(false), which
    // publishes the metadata sync invalidation that unblocks every client
    expect(fake.setProcessingCalls()).toContain(false);
    expect(fake.isProcessing()).toBe(false);
  });

  test("returns false for a conversation that is not registered", () => {
    // GIVEN no conversation registered under the id

    // WHEN the user cancels generation for the unknown id
    const cancelled = cancelGeneration("cancel-clears-processing-unknown-id");

    // THEN the cancel reports that nothing was found
    expect(cancelled).toBe(false);
  });
});
