/**
 * Tests for the per-conversation end-of-turn tail chain.
 *
 * The chain lives at module scope keyed by conversation id, which is the whole
 * point: a tail runs after the agent loop released the processing lock, so the
 * conversation reads idle and the live `Conversation` instance can be evicted
 * and rebuilt underneath it. These tests pin the two properties that depend on
 * that: tails scheduled from different instances of the same conversation still
 * run in order, and the map does not accumulate an entry per conversation the
 * daemon has ever served.
 */

import { describe, expect, test } from "bun:test";

import {
  __turnTailChainSizeForTests,
  chainTurnTail,
  settleTurnTail,
} from "../daemon/turn-tail-chain.js";

/** Unique per test so cases cannot chain onto each other's tails. */
let nextConversationSeq = 0;
function conversationId(): string {
  nextConversationSeq += 1;
  return `turn-tail-conv-${nextConversationSeq}`;
}

describe("turn-tail-chain", () => {
  test("tails scheduled for one conversation run strictly in order", async () => {
    const id = conversationId();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHangs = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    // The first instance schedules its tail and is then disposed, so the
    // second tail is scheduled with no reference to the first.
    chainTurnTail(id, async () => {
      order.push("first:start");
      await firstHangs;
      order.push("first:end");
    });
    chainTurnTail(id, async () => {
      order.push("second:start");
      order.push("second:end");
    });

    // The second tail is parked behind the first rather than overlapping it.
    await Promise.resolve();
    expect(order).toEqual(["first:start"]);

    releaseFirst?.();
    await settleTurnTail(id);
    expect(order).toEqual([
      "first:start",
      "first:end",
      "second:start",
      "second:end",
    ]);
  });

  test("a rejected tail neither escapes nor poisons the tails behind it", async () => {
    const id = conversationId();
    const order: string[] = [];

    chainTurnTail(id, async () => {
      order.push("first");
      throw new Error("tail exploded");
    });
    chainTurnTail(id, async () => {
      order.push("second");
    });

    // The chain settles rather than rejecting, so the throw can neither surface
    // as an unhandled rejection nor skip the queued tail.
    await settleTurnTail(id);
    expect(order).toEqual(["first", "second"]);
  });

  test("separate conversations run their tails concurrently", async () => {
    const first = conversationId();
    const second = conversationId();
    const order: string[] = [];
    let releaseFirst: (() => void) | undefined;
    const firstHangs = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    chainTurnTail(first, async () => {
      order.push("first:start");
      await firstHangs;
      order.push("first:end");
    });
    chainTurnTail(second, async () => {
      order.push("second");
    });

    await settleTurnTail(second);
    expect(order).toEqual(["first:start", "second"]);

    releaseFirst?.();
    await settleTurnTail(first);
    expect(order).toEqual(["first:start", "second", "first:end"]);
  });

  test("the chain entry is released once the last tail settles", async () => {
    const id = conversationId();
    const sizeBefore = __turnTailChainSizeForTests();

    let releaseTail: (() => void) | undefined;
    const tailHangs = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    chainTurnTail(id, () => tailHangs);
    chainTurnTail(id, async () => {});

    // Both tails share the one entry the conversation is allowed.
    expect(__turnTailChainSizeForTests()).toBe(sizeBefore + 1);

    releaseTail?.();
    await settleTurnTail(id);
    // The cleanup link runs a microtask after the tail body, so let it land.
    await Promise.resolve();
    expect(__turnTailChainSizeForTests()).toBe(sizeBefore);

    // A later turn on the same conversation still chains normally.
    const order: string[] = [];
    chainTurnTail(id, async () => {
      order.push("later");
    });
    await settleTurnTail(id);
    expect(order).toEqual(["later"]);
  });
});
