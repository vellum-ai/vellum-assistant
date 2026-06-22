/**
 * Cancel contract: a user cancel raises the conversation's AbortController and
 * defers clearing the `processing` flag to the in-flight turn's `finally`.
 *
 * `cancelGeneration` no longer force-clears `processing` itself. Abort now
 * propagates into the provider call and tool execution — and is backed by the
 * agent loop's abort watchdog — so a cancelled turn always reaches its
 * `finally` within a bounded time and tears down its own state there. The
 * watchdog-driven path (turn reaches `finally`, processing clears) is covered
 * by `conversation-agent-loop.test.ts`; this file pins the handler-side
 * contract: cancel signals abort and leaves the flag to the turn.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import { cancelGeneration } from "../daemon/handlers/conversations.js";

interface CancelledConversation {
  isProcessing: () => boolean;
  setProcessingCalls: () => boolean[];
  abortCount: () => number;
}

/**
 * Register a conversation whose in-flight turn is processing. The fake records
 * abort calls and any `setProcessing` writes so the test can assert that
 * `cancelGeneration` signals abort without flipping the flag itself.
 */
function registerProcessingTurn(id: string): CancelledConversation {
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

  test("raises abort and defers clearing processing to the turn's finally", () => {
    // GIVEN a registered conversation that is processing
    const fake = registerProcessingTurn(conversationId);
    expect(fake.isProcessing()).toBe(true);

    // WHEN the user cancels generation
    const cancelled = cancelGeneration(conversationId);

    // THEN the cancel is acknowledged
    expect(cancelled).toBe(true);
    // AND the abort signal is raised on the conversation
    expect(fake.abortCount()).toBe(1);
    // AND cancelGeneration does NOT force-clear the flag itself — the in-flight
    // turn's `finally` owns that teardown once abort drives it there.
    expect(fake.setProcessingCalls()).not.toContain(false);
    expect(fake.isProcessing()).toBe(true);
  });

  test("returns false for a conversation that is not registered", () => {
    // GIVEN no conversation registered under the id

    // WHEN the user cancels generation for the unknown id
    const cancelled = cancelGeneration("cancel-clears-processing-unknown-id");

    // THEN the cancel reports that nothing was found
    expect(cancelled).toBe(false);
  });
});
