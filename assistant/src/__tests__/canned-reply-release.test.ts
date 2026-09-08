/**
 * The canned-reply routes (canned first greeting, unknown slash command) hold
 * the processing lock themselves and release it from a deferred callback that
 * also publishes their client event burst. That release is the only one those
 * turns get: no agent loop runs, so a throw escaping the burst would latch the
 * conversation "processing" for the life of the daemon and queue every later
 * send behind an idle conversation.
 *
 * It releases the claim its scheduler took, and only that one: the timer fires
 * a tick after the route returned, so a Stop and a fresh acquire can land in
 * between, and clearing there would free a turn that is running.
 */
import { describe, expect, test } from "bun:test";

import type { QueueDrainReason } from "../daemon/conversation-queue-manager.js";
import { scheduleCannedReplyRelease } from "../runtime/routes/canned-reply-release.js";

function makeConversation(owner = 1) {
  let processing = true;
  let holder = owner;
  const drainOrigins: string[] = [];
  return {
    isProcessing: () => processing,
    drainOrigins,
    /** The force-clear-then-reacquire a Stop and a new request perform. */
    claimAway: (nextOwner: number) => {
      processing = true;
      holder = nextOwner;
    },
    target: {
      releaseProcessing: (claim: number) => {
        if (claim !== holder) {
          return false;
        }
        processing = false;
        return true;
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
        releaseProcessing: (claim: number) => {
          order.push("release");
          return conversation.target.releaseProcessing(claim);
        },
        kickDrainQueue: conversation.target.kickDrainQueue,
      },
      owner: 1,
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
      owner: 1,
      origin: "slash_command",
      emit: () => {
        throw new Error("broadcast exploded");
      },
    });

    await nextTick();

    expect(conversation.isProcessing()).toBe(false);
    expect(conversation.drainOrigins).toEqual(["slash_command"]);
  });

  test("leaves a hold claimed away since it was scheduled alone", async () => {
    // Stop force-clears the flag and the next request acquires, all before
    // this timer runs. Clearing here would release a turn that is running,
    // and kicking the drain would start the next message inside it.
    const conversation = makeConversation();
    const after: string[] = [];

    scheduleCannedReplyRelease({
      conversation: conversation.target,
      owner: 1,
      origin: "canned_greeting",
      emit: () => {},
      afterRelease: () => {
        after.push("after");
      },
    });

    conversation.claimAway(2);
    await nextTick();

    // The newer hold survives, nothing drains into the turn that owns it, and
    // the follow-up work waits for whoever does.
    expect(conversation.isProcessing()).toBe(true);
    expect(conversation.drainOrigins).toEqual([]);
    expect(after).toEqual([]);
  });
});
