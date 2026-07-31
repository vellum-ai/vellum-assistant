/**
 * The canned-reply routes (canned first greeting, unknown slash command) hold
 * the processing lock themselves and release it from a deferred callback that
 * also publishes their client event burst. That release is the only one those
 * turns get: no agent loop runs, so a throw escaping the burst would latch the
 * conversation "processing" for the life of the daemon and queue every later
 * send behind an idle conversation.
 */
import { describe, expect, test } from "bun:test";

import type { QueueDrainReason } from "../daemon/conversation-queue-manager.js";
import { scheduleCannedReplyRelease } from "../runtime/routes/canned-reply-release.js";

function makeConversation() {
  let processing = true;
  const drainOrigins: string[] = [];
  return {
    isProcessing: () => processing,
    drainOrigins,
    target: {
      setProcessing: (value: boolean) => {
        processing = value;
      },
      kickDrainQueue: (_reason?: QueueDrainReason, origin?: string) => {
        drainOrigins.push(origin ?? "");
        return Promise.resolve();
      },
    },
  };
}

/** Let the scheduled `setTimeout(..., 0)` callback run. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("scheduleCannedReplyRelease", () => {
  test("releases and drains after the deferred event burst", async () => {
    const conversation = makeConversation();
    const order: string[] = [];

    scheduleCannedReplyRelease({
      conversation: {
        setProcessing: (value: boolean) => {
          order.push("release");
          conversation.target.setProcessing(value);
        },
        kickDrainQueue: conversation.target.kickDrainQueue,
      },
      origin: "canned_greeting",
      emit: () => {
        order.push("emit");
      },
      afterRelease: () => {
        order.push("after");
      },
    });

    // Nothing runs synchronously: the HTTP response has to reach the client
    // before its events do.
    expect(order).toEqual([]);

    await nextTick();

    expect(order).toEqual(["emit", "release", "after"]);
    expect(conversation.isProcessing()).toBe(false);
    expect(conversation.drainOrigins).toEqual(["canned_greeting"]);
  });

  test("still releases and drains when a broadcast throws", async () => {
    const conversation = makeConversation();

    scheduleCannedReplyRelease({
      conversation: conversation.target,
      origin: "slash_command",
      emit: () => {
        throw new Error("broadcast exploded");
      },
    });

    await nextTick();

    expect(conversation.isProcessing()).toBe(false);
    expect(conversation.drainOrigins).toEqual(["slash_command"]);
  });
});
