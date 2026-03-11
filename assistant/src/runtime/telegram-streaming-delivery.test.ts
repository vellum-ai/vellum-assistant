import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { ApprovalUIMetadata } from "./channel-approval-types.js";
import type { ChannelDeliveryResult } from "./gateway-client.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

let callCount = 0;
const mockDeliverChannelReply = mock(
  async (): Promise<ChannelDeliveryResult> => {
    callCount++;
    return { ok: true, messageId: 99 + callCount };
  },
);

mock.module("./gateway-client.js", () => ({
  deliverChannelReply: mockDeliverChannelReply,
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { TelegramStreamingDelivery } from "./telegram-streaming-delivery.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type CallArgs = [string, Record<string, unknown>, string];

/** Extract the payload (second argument) from the Nth mock call. */
function callPayload(n: number): Record<string, unknown> {
  const args = mockDeliverChannelReply.mock.calls[n] as unknown as CallArgs;
  return args[1];
}

function createDelivery(): TelegramStreamingDelivery {
  return new TelegramStreamingDelivery({
    callbackUrl: "http://test/deliver",
    chatId: "123",
    mintBearerToken: () => "test-token",
  });
}

/** Flush all pending microtasks / promise callbacks. */
async function flushPromises(): Promise<void> {
  // Multiple rounds to handle chained .then() callbacks
  for (let i = 0; i < 10; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TelegramStreamingDelivery", () => {
  beforeEach(() => {
    callCount = 0;
    mockDeliverChannelReply.mockReset();
    mockDeliverChannelReply.mockImplementation(
      async (): Promise<ChannelDeliveryResult> => {
        callCount++;
        return { ok: true, messageId: 99 + callCount };
      },
    );
  });

  afterEach(() => {
    mockDeliverChannelReply.mockReset();
  });

  // ── Test 1: initial send when buffer reaches MIN_INITIAL_CHARS ──────
  test("sends initial message when buffer reaches MIN_INITIAL_CHARS", async () => {
    const delivery = createDelivery();
    // MIN_INITIAL_CHARS is 20; send 25 chars
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });

    await flushPromises();

    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    const payload = callPayload(0);
    expect(payload.text).toBe("a".repeat(25));
    // Initial send should NOT have a messageId (it's a new message)
    expect(payload.messageId).toBeUndefined();
  });

  // ── Test 2: edits message with accumulated text on finish() ─────────
  test("edits message with accumulated text on finish()", async () => {
    const delivery = createDelivery();
    // First: send enough to trigger initial send
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();

    // Then add more text and finish
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "b".repeat(10),
    });
    await delivery.finish();

    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(2);

    // First call: new message (no messageId)
    const firstPayload = callPayload(0);
    expect(firstPayload.messageId).toBeUndefined();

    // Second call: edit (with messageId from first call)
    const secondPayload = callPayload(1);
    expect(secondPayload.messageId).toBe(100); // first call returns messageId: 100
    expect(secondPayload.text).toBe("a".repeat(25) + "b".repeat(10));
  });

  // ── Test 3: sends remainder as new message when messageId missing ───
  test("sends remainder as new message when messageId is missing", async () => {
    // First call: no messageId in response; second call: with messageId
    mockDeliverChannelReply.mockReset();
    let localCallCount = 0;
    mockDeliverChannelReply.mockImplementation(
      async (): Promise<ChannelDeliveryResult> => {
        localCallCount++;
        if (localCallCount === 1) return { ok: true }; // no messageId
        return { ok: true, messageId: 200 };
      },
    );

    const delivery = createDelivery();
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();

    delivery.onEvent({
      type: "assistant_text_delta",
      text: "b".repeat(10),
    });
    await delivery.finish();

    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(2);

    // The initial text was already delivered (just without a messageId),
    // so the second call should contain only the remainder (buffer text)
    const secondPayload = callPayload(1);
    expect(secondPayload.text).toBe("b".repeat(10));
    // It's sent as a new message (no messageId in payload) since the first
    // call didn't return one
    expect(secondPayload.messageId).toBeUndefined();
  });

  // ── Test 4: sends full text when initial send fails ─────────────────
  test("sends full text when initial send fails", async () => {
    mockDeliverChannelReply.mockReset();
    let localCallCount = 0;
    mockDeliverChannelReply.mockImplementation(
      async (): Promise<ChannelDeliveryResult> => {
        localCallCount++;
        if (localCallCount === 1) throw new Error("Network error");
        return { ok: true, messageId: 300 };
      },
    );

    const delivery = createDelivery();
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();

    // The initial send failed; buffer should be restored
    await delivery.finish();

    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(2);

    // The finish() call should send the complete accumulated text
    const secondPayload = callPayload(1);
    expect(secondPayload.text).toBe("a".repeat(25));
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 5: tool_use_start between text segments produces single message ─
  test("tool_use_start between text segments produces single message", async () => {
    const delivery = createDelivery();

    // Send enough text to trigger initial message (>= MIN_INITIAL_CHARS=20)
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "Yeah, still here! ", // 18 chars
    });
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "aa", // Push past 20 chars
    });
    await flushPromises();

    // Initial message sent
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    const initialPayload = callPayload(0);
    expect(initialPayload.messageId).toBeUndefined(); // new message

    // tool_use_start — should NOT finalize/reset message state
    delivery.onEvent({
      type: "tool_use_start",
      toolName: "memory_recall",
      input: {},
    });
    await flushPromises();

    // More text after the tool call
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "What do you need?",
    });

    await delivery.finish();

    // The final edit should be to the SAME message (same messageId),
    // containing the full combined text
    const lastCallIndex = mockDeliverChannelReply.mock.calls.length - 1;
    const lastPayload = callPayload(lastCallIndex);
    expect(lastPayload.messageId).toBe(100); // same messageId as initial
    expect(lastPayload.text).toBe("Yeah, still here! aaWhat do you need?");
  });

  // ── Test 5b: multiple tool calls between text segments ──────────────
  test("multiple tool calls between text segments produce single message", async () => {
    const delivery = createDelivery();

    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    // Two consecutive tool calls
    delivery.onEvent({ type: "tool_use_start", toolName: "tool1", input: {} });
    delivery.onEvent({ type: "tool_use_start", toolName: "tool2", input: {} });

    // More text after both tool calls
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "b".repeat(10),
    });
    await delivery.finish();

    // All text should be in the same message
    const lastCallIndex = mockDeliverChannelReply.mock.calls.length - 1;
    const lastPayload = callPayload(lastCallIndex);
    expect(lastPayload.messageId).toBe(100);
    expect(lastPayload.text).toBe("a".repeat(25) + "b".repeat(10));
  });

  // ── Test 5c: tool_use_start before any text is a no-op ─────────────
  test("tool_use_start before any text is a no-op", async () => {
    const delivery = createDelivery();

    delivery.onEvent({
      type: "tool_use_start",
      toolName: "init_tool",
      input: {},
    });
    await flushPromises();

    // No messages should have been sent
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(0);

    // Subsequent text should work normally
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    await delivery.finish();
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 5d: tool_use_start at end of response finalizes on finish ──
  test("tool_use_start at end of response finalizes on finish", async () => {
    const delivery = createDelivery();

    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();

    delivery.onEvent({
      type: "tool_use_start",
      toolName: "final_tool",
      input: {},
    });
    await delivery.finish();

    // The text should have been delivered via the initial message + a final edit
    expect(delivery.finishSucceeded).toBe(true);
    expect(delivery.hasDeliveredText).toBe(true);
  });

  // ── Test 5e: text exceeding max length after tool pause splits at length boundary ─
  test("text exceeding max length after tool pause splits at length boundary", async () => {
    const delivery = createDelivery();

    // Send ~3900 chars
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(3900),
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    // Tool call (should not split)
    delivery.onEvent({ type: "tool_use_start", toolName: "lookup", input: {} });

    // Send 200 more chars (total 4100 > 4000 limit)
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "b".repeat(200),
    });

    await delivery.finish();
    await flushPromises();

    // Should have split at 4000-char boundary:
    // 1. Initial message (3900 chars)
    // 2. Edit at boundary (4000 chars)
    // 3. Overflow new message (100 chars)
    const calls = mockDeliverChannelReply.mock.calls.length;
    expect(calls).toBe(3);

    // Edit at boundary
    const editPayload = callPayload(1);
    expect((editPayload.text as string).length).toBe(4000);
    expect(editPayload.messageId).toBeDefined();

    // Overflow as new message
    const overflowPayload = callPayload(2);
    expect((overflowPayload.text as string).length).toBe(100);
    expect(overflowPayload.messageId).toBeUndefined();
  });

  // ── Test 5f: preserves below-threshold text across tool_use_start ───
  test("preserves below-threshold text across tool_use_start", async () => {
    const delivery = createDelivery();

    // Send text below MIN_INITIAL_CHARS threshold
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "Hi! ", // 4 chars, well below 20
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(0); // not sent yet

    // tool_use_start
    delivery.onEvent({
      type: "tool_use_start",
      toolName: "memory_recall",
      input: {},
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(0); // still not sent

    // More text after tool (enough to trigger initial send when combined)
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "What can I help with?", // 21 chars, combined = 25 >= 20
    });
    await flushPromises();

    // Should have sent initial message with ALL text (pre-tool + post-tool)
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    const payload = callPayload(0);
    expect(payload.text).toBe("Hi! What can I help with?");

    await delivery.finish();
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 5g: delivers below-threshold text when tool_use_start is followed by finish ─
  test("delivers below-threshold text when tool_use_start is followed by finish", async () => {
    const delivery = createDelivery();

    delivery.onEvent({
      type: "assistant_text_delta",
      text: "Hi!", // 3 chars
    });
    delivery.onEvent({
      type: "tool_use_start",
      toolName: "lookup",
      input: {},
    });

    await delivery.finish();

    // The "Hi!" should have been sent as a new message during finish
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    const payload = callPayload(0);
    expect(payload.text).toBe("Hi!");
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 5h: no-messageId response doesn't cause duplicate messages on continued deltas ─
  test("no-messageId response doesn't cause duplicate messages on continued deltas", async () => {
    // Simulate the exact bug from the screenshot: initial send succeeds
    // without messageId, then more deltas create overlapping new messages
    mockDeliverChannelReply.mockReset();
    mockDeliverChannelReply.mockImplementation(
      async (): Promise<ChannelDeliveryResult> => {
        // All sends return no messageId (simulates gateway omitting it)
        return { ok: true };
      },
    );

    const delivery = createDelivery();

    // First batch: triggers sendInitialMessage (>= 20 chars)
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "Alright, hit me with something",
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    expect(callPayload(0).text).toBe("Alright, hit me with something");

    // More deltas arrive — should NOT trigger another sendInitialMessage
    delivery.onEvent({
      type: "assistant_text_delta",
      text: " longer and let's see if it comes through as one",
    });
    await flushPromises();
    // Still only 1 call — text accumulates in buffer
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    delivery.onEvent({
      type: "assistant_text_delta",
      text: " message now!",
    });
    await delivery.finish();

    // finish() should send the remainder as a single new message
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(2);
    const finishPayload = callPayload(1);
    expect(finishPayload.text).toBe(
      " longer and let's see if it comes through as one message now!",
    );
    expect(finishPayload.messageId).toBeUndefined();
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 5i: combined threshold accounts for pre-tool currentMessageText ─
  test("combined threshold accounts for pre-tool currentMessageText", async () => {
    const delivery = createDelivery();

    // Send 15 chars (below 20 threshold)
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "Hello, world!! ", // 15 chars
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(0);

    // tool_use_start moves 15 chars to currentMessageText
    delivery.onEvent({
      type: "tool_use_start",
      toolName: "lookup",
      input: {},
    });

    // Send only 6 more chars — buffer alone (6) < 20, but combined (21) >= 20
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "Great!",
    });
    await flushPromises();

    // Should have triggered initial send with combined text
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    expect(callPayload(0).text).toBe("Hello, world!! Great!");

    await delivery.finish();
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 5j: no-messageId + tool_use_start + finish delivers post-tool text ─
  test("no-messageId + tool_use_start + finish delivers post-tool text", async () => {
    // Scenario from Devin review: initial send succeeds without messageId,
    // more deltas arrive, tool_use_start fires, finish() must deliver post-tool text.
    mockDeliverChannelReply.mockReset();
    let localCallCount = 0;
    mockDeliverChannelReply.mockImplementation(
      async (): Promise<ChannelDeliveryResult> => {
        localCallCount++;
        if (localCallCount === 1) return { ok: true }; // no messageId
        return { ok: true, messageId: 400 };
      },
    );

    const delivery = createDelivery();

    // Step 1: initial send (>= 20 chars), succeeds without messageId
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    // Step 2: more deltas arrive — stuck in buffer (onTextDelta skips both branches)
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "post-tool text",
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1); // no new call

    // Step 3: tool_use_start — buffer should NOT be moved to currentMessageText
    delivery.onEvent({
      type: "tool_use_start",
      toolName: "some_tool",
      input: {},
    });

    // Step 4: finish() — should deliver the post-tool text as a new message
    await delivery.finish();

    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(2);
    const secondPayload = callPayload(1);
    expect(secondPayload.text).toBe("post-tool text");
    expect(secondPayload.messageId).toBeUndefined(); // new message, not edit
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 5k: no-messageId + finish with approval sends approval as new message ─
  test("no-messageId + finish with approval sends approval as new message", async () => {
    // Scenario from Codex review: initial send succeeds without messageId,
    // no additional buffer, but finish(approval) must still deliver approval buttons.
    mockDeliverChannelReply.mockReset();
    mockDeliverChannelReply.mockImplementation(
      async (): Promise<ChannelDeliveryResult> => {
        return { ok: true }; // no messageId
      },
    );

    const delivery = createDelivery();

    // Initial send succeeds without messageId
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    // finish() with approval — approval must not be silently dropped
    const approval: ApprovalUIMetadata = {
      requestId: "test-req",
      actions: [{ id: "approve_once", label: "Approve" }],
      plainTextFallback: "Reply APPROVE or REJECT",
    };
    await delivery.finish(approval);

    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(2);
    const secondPayload = callPayload(1);
    // Approval buttons sent as a new message
    expect(secondPayload.approval).toEqual(approval);
    expect(secondPayload.messageId).toBeUndefined();
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 5l: no-messageId + buffer + finish with approval delivers both ─
  test("no-messageId + buffer + finish with approval delivers both text and approval", async () => {
    // Combined scenario: no-messageId initial send, buffered text, and approval buttons.
    mockDeliverChannelReply.mockReset();
    let localCallCount = 0;
    mockDeliverChannelReply.mockImplementation(
      async (): Promise<ChannelDeliveryResult> => {
        localCallCount++;
        if (localCallCount === 1) return { ok: true }; // no messageId
        return { ok: true, messageId: 500 };
      },
    );

    const delivery = createDelivery();

    // Initial send succeeds without messageId
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    // More deltas arrive
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "remainder",
    });

    // finish() with approval — should deliver buffer text + approval together
    const approval: ApprovalUIMetadata = {
      requestId: "test-req",
      actions: [{ id: "approve_once", label: "Approve" }],
      plainTextFallback: "Reply APPROVE or REJECT",
    };
    await delivery.finish(approval);

    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(2);
    const secondPayload = callPayload(1);
    expect(secondPayload.text).toBe("remainder");
    expect(secondPayload.approval).toEqual(approval);
    expect(secondPayload.messageId).toBeUndefined();
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 6: skips final edit when text hasn't changed ───────────────
  test("skips final edit when text hasn't changed", async () => {
    const delivery = createDelivery();

    // Feed exactly MIN_INITIAL_CHARS (20) to trigger initial send
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(20),
    });
    await flushPromises();

    // Initial send should have fired
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    // Call finish() with no additional text
    await delivery.finish();

    // Should NOT have made a second call since text hasn't changed
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 7: splits message at TELEGRAM_MAX_TEXT_LEN boundary ────────
  test("splits message at TELEGRAM_MAX_TEXT_LEN boundary", async () => {
    const delivery = createDelivery();

    // Send initial chunk to start a message (>= 20 chars)
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();

    // Initial send fired
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    // Now send enough to exceed TELEGRAM_MAX_TEXT_LEN (4000) when combined
    // with the initial 25 chars. The edit is throttled, so the buffer
    // accumulates until finish() flushes it. finish() has its own overflow
    // handling that splits at the 4000-char boundary.
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "b".repeat(4500),
    });

    // Call finish() to flush — this triggers the overflow split in finish()
    await delivery.finish();
    await flushPromises();

    // finish() should have: (1) edited the current message with up to 4000
    // chars, then (2) sent the overflow as a new message.
    // Total calls: 1 (initial) + 1 (edit at boundary) + 1 (overflow new message) = 3
    expect(mockDeliverChannelReply.mock.calls.length).toBe(3);

    // The second call (edit at boundary) should have text of length 4000
    const editPayload = callPayload(1);
    expect((editPayload.text as string).length).toBe(4000);
    expect(editPayload.messageId).toBeDefined();

    // The third call (overflow) should be a new message (no messageId in payload)
    const overflowPayload = callPayload(2);
    expect(overflowPayload.messageId).toBeUndefined();
    // Overflow should contain the remainder: 25 + 4500 - 4000 = 525 chars
    expect((overflowPayload.text as string).length).toBe(525);

    expect(delivery.finishSucceeded).toBe(true);
  });

  // ── Test 8: ignores events after finish() is called ─────────────────
  test("ignores events after finish() is called", async () => {
    const delivery = createDelivery();

    // Send initial text to trigger a message
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "a".repeat(25),
    });
    await flushPromises();
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);

    // Finish
    await delivery.finish();

    const callsAfterFinish = mockDeliverChannelReply.mock.calls.length;

    // Now send more events -- they should be ignored
    delivery.onEvent({
      type: "assistant_text_delta",
      text: "ignored text",
    });
    delivery.onEvent({
      type: "tool_use_start",
      toolName: "ignored_tool",
      input: {},
    });
    await flushPromises();

    // No additional calls should have been made
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(callsAfterFinish);
  });
});
