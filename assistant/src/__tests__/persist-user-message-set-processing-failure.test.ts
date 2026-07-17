/**
 * Regression: `persistUserMessage` calls `ctx.setProcessing(true)`, which
 * persists the flag to the DB and can throw (e.g. SQLITE_BUSY). That call must
 * run inside the function's try/catch so a failure unwinds the request-id and
 * abort-controller bookkeeping instead of stranding it on the conversation.
 * A later failure while clearing the flag must not mask the original error.
 */
import { describe, expect, test } from "bun:test";

import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import { persistUserMessage } from "../daemon/conversation-messaging.js";

type SetProcessingBehavior = (value: boolean) => void;

function makeContext(
  setProcessing: SetProcessingBehavior,
): MessagingConversationContext & {
  processing: boolean;
} {
  let processing = false;
  const ctx = {
    conversationId: "conv-set-processing-failure",
    messages: [],
    abortController: null,
    currentRequestId: undefined,
    queue: {} as never,
    get processing() {
      return processing;
    },
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      setProcessing(value);
      processing = value;
    },
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
  } as unknown as MessagingConversationContext & { processing: boolean };
  return ctx;
}

describe("persistUserMessage setProcessing failure", () => {
  test("clears request-id and abort bookkeeping when setProcessing(true) throws", async () => {
    const ctx = makeContext((value) => {
      if (value) throw new Error("database is locked (SQLITE_BUSY)");
    });

    await expect(
      persistUserMessage(ctx, { content: "hello", requestId: "req-1" }),
    ).rejects.toThrow("database is locked");

    expect(ctx.currentRequestId).toBeUndefined();
    expect(ctx.abortController).toBeNull();
    expect(ctx.isProcessing()).toBe(false);
  });

  test("retries a transient SQLITE_BUSY from setProcessing(true)", async () => {
    // A coded SQLITE_BUSY is transient WAL contention: `persistUserMessage`
    // wraps the acquiring `setProcessing(true)` in `withSqliteRetry`, so it is
    // re-attempted rather than failing the send immediately.
    let trueCalls = 0;
    const ctx = makeContext((value) => {
      if (value) {
        trueCalls += 1;
        throw Object.assign(new Error("database is locked"), {
          code: "SQLITE_BUSY",
        });
      }
    });

    await expect(
      persistUserMessage(ctx, { content: "hello", requestId: "req-busy" }),
    ).rejects.toThrow("database is locked");

    // Initial attempt + 3 retries before withSqliteRetry gives up.
    expect(trueCalls).toBe(4);
    expect(ctx.currentRequestId).toBeUndefined();
    expect(ctx.abortController).toBeNull();
  });

  test("does not retry a non-transient setProcessing(true) failure", async () => {
    // No SQLite code / a non-BUSY code → not contention → fail fast, no retry.
    let trueCalls = 0;
    const ctx = makeContext((value) => {
      if (value) {
        trueCalls += 1;
        throw new Error("boom");
      }
    });

    await expect(
      persistUserMessage(ctx, { content: "hello", requestId: "req-boom" }),
    ).rejects.toThrow("boom");

    expect(trueCalls).toBe(1);
  });

  test("a failing clear does not mask the original persist error", async () => {
    // setProcessing throws on both the set and the clear; the original error
    // must still propagate and the bookkeeping must still be reset.
    const ctx = makeContext(() => {
      throw new Error("database is locked (SQLITE_BUSY)");
    });

    await expect(
      persistUserMessage(ctx, { content: "hello", requestId: "req-2" }),
    ).rejects.toThrow("database is locked");

    expect(ctx.currentRequestId).toBeUndefined();
    expect(ctx.abortController).toBeNull();
  });
});
