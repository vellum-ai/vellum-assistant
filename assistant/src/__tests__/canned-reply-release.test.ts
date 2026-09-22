/**
 * The canned-reply routes hold the processing flag themselves and release it a
 * tick after the route returned, so a Stop and a fresh acquire can land in
 * between, and clearing there would free a turn that is running.
 */
import { describe, expect, test } from "bun:test";

import { scheduleCannedReplyRelease } from "../runtime/routes/canned-reply-release.js";

function makeConversation(owner = 1) {
  let processing = true;
  let holder = owner;
  return {
    isProcessing: () => processing,
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
    },
  };
}

/** Let the scheduled `setTimeout(..., 0)` callback run. */
function nextTick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

describe("scheduleCannedReplyRelease", () => {
  test("releases after the deferred event burst", async () => {
    const conversation = makeConversation();
    const order: string[] = [];

    scheduleCannedReplyRelease({
      conversation: {
        releaseProcessing: (claim: number) => {
          order.push("release");
          return conversation.target.releaseProcessing(claim);
        },
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
  });

  test("still releases when a broadcast throws", async () => {
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
  });

  test("leaves a hold claimed away since it was scheduled alone", async () => {
    // Stop force-clears the flag and the next request acquires, all before
    // this timer runs. Clearing here would release a turn that is running.
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

    // The newer hold survives and the follow-up work waits for whoever does.
    expect(conversation.isProcessing()).toBe(true);
    expect(after).toEqual([]);
  });
});
