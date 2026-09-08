/**
 * How `persistUserMessage` takes and gives back the conversation's processing
 * flag.
 *
 * It acquires rather than sets: the read and the take are one step, and the
 * hold it takes is released only by the claim that took it. That is what keeps
 * a turn that is starting from publishing an idle conversation, and what keeps
 * an earlier holder from releasing a turn that claimed the flag away.
 *
 * A failure anywhere after the acquire must unwind the request-id and
 * abort-controller bookkeeping rather than stranding it on the conversation,
 * and a failure while releasing must not mask the original error.
 */
import { describe, expect, test } from "bun:test";

import type { MessagingConversationContext } from "../daemon/conversation-messaging.js";
import {
  CONVERSATION_BUSY_MESSAGE,
  persistUserMessage,
} from "../daemon/conversation-messaging.js";

interface ContextBehavior {
  /** Answered in place of taking the flag. `undefined` takes it for real. */
  acquire?: () => Promise<number | null>;
  /** Runs before the release completes, so it can throw. */
  onRelease?: (owner: number) => void;
}

function makeContext(behavior: ContextBehavior = {}): {
  ctx: MessagingConversationContext;
  processing: () => boolean;
  releases: number[];
} {
  let processing = false;
  let owner = 0;
  const releases: number[] = [];
  const ctx = {
    conversationId: "conv-processing-ownership",
    messages: [],
    abortController: null,
    currentRequestId: undefined,
    queue: {} as never,
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    acquireProcessingFenced: async () => {
      if (behavior.acquire) {
        return behavior.acquire();
      }
      if (processing) {
        return null;
      }
      processing = true;
      owner += 1;
      return owner;
    },
    releaseProcessing: (claim: number) => {
      releases.push(claim);
      behavior.onRelease?.(claim);
      if (claim !== owner) {
        return false;
      }
      processing = false;
      return true;
    },
    getTurnChannelContext: () => null,
    getTurnInterfaceContext: () => null,
  } as unknown as MessagingConversationContext;
  return { ctx, processing: () => processing, releases };
}

describe("persistUserMessage processing ownership", () => {
  test("unwinds its bookkeeping and its hold when the persist fails", async () => {
    // No database stands behind this context, so the body throws. The flag it
    // took has to come back with it.
    const { ctx, processing, releases } = makeContext();

    await expect(
      persistUserMessage(ctx, { content: "hello", requestId: "req-1" }),
    ).rejects.toThrow();

    expect(ctx.currentRequestId).toBeUndefined();
    expect(ctx.abortController).toBeNull();
    expect(processing()).toBe(false);
    expect(releases).toEqual([1]);
  });

  test("refuses a conversation another holder is already processing", async () => {
    const { ctx, releases } = makeContext();
    ctx.setProcessing(true);

    await expect(
      persistUserMessage(ctx, { content: "hello", requestId: "req-busy" }),
    ).rejects.toThrow(CONVERSATION_BUSY_MESSAGE);

    // Nothing was taken, so nothing is given back.
    expect(releases).toEqual([]);
  });

  test("reports busy rather than stealing a flag the acquire finds taken", async () => {
    // The acquire is the only thing that decides: a caller cannot set its way
    // past a holder.
    const { ctx, releases } = makeContext({ acquire: async () => null });

    await expect(
      persistUserMessage(ctx, { content: "hello", requestId: "req-taken" }),
    ).rejects.toThrow(CONVERSATION_BUSY_MESSAGE);

    expect(ctx.currentRequestId).toBeUndefined();
    expect(ctx.abortController).toBeNull();
    expect(releases).toEqual([]);
  });

  test("a failing release does not mask the original error", async () => {
    const { ctx } = makeContext({
      onRelease: () => {
        throw new Error("release exploded");
      },
    });

    const attempt = persistUserMessage(ctx, {
      content: "hello",
      requestId: "req-2",
    });
    await expect(attempt).rejects.not.toThrow("release exploded");

    expect(ctx.currentRequestId).toBeUndefined();
    expect(ctx.abortController).toBeNull();
  });
});
