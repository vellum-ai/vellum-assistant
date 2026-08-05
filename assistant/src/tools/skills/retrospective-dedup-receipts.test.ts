/**
 * Tests for the retrospective dedup-receipt registry: LIFO consume semantics,
 * the per-conversation receipt cap, and the tracked-conversation leak bound.
 * The executor-facing behavior (record on find, require + consume on
 * scaffold) is covered where those executors are tested.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import {
  consumeDedupReceipt,
  hasDedupReceipt,
  recordDedupReceipt,
  resetDedupReceiptsForTests,
} from "./retrospective-dedup-receipts.js";

beforeEach(() => {
  resetDedupReceiptsForTests();
});

describe("retrospective dedup receipts", () => {
  test("empty registry holds nothing and consumes nothing", () => {
    expect(hasDedupReceipt("conv-1")).toBe(false);
    expect(consumeDedupReceipt("conv-1")).toBeNull();
  });

  test("consume pops the most recent receipt and empties out", () => {
    recordDedupReceipt("conv-1", "first goal");
    recordDedupReceipt("conv-1", "second goal");

    expect(hasDedupReceipt("conv-1")).toBe(true);
    expect(consumeDedupReceipt("conv-1")?.goal).toBe("second goal");
    expect(consumeDedupReceipt("conv-1")?.goal).toBe("first goal");
    expect(hasDedupReceipt("conv-1")).toBe(false);
    expect(consumeDedupReceipt("conv-1")).toBeNull();
  });

  test("receipts are scoped per conversation", () => {
    recordDedupReceipt("conv-1", "goal a");

    expect(hasDedupReceipt("conv-2")).toBe(false);
    expect(consumeDedupReceipt("conv-2")).toBeNull();
    expect(hasDedupReceipt("conv-1")).toBe(true);
  });

  test("per-conversation cap drops the oldest receipts first", () => {
    for (let i = 0; i < 20; i++) {
      recordDedupReceipt("conv-1", `goal ${i}`);
    }
    // Cap is 16: goals 4..19 survive, newest out first.
    const goals: string[] = [];
    for (;;) {
      const receipt = consumeDedupReceipt("conv-1");
      if (!receipt) {
        break;
      }
      goals.push(receipt.goal);
    }
    expect(goals).toHaveLength(16);
    expect(goals[0]).toBe("goal 19");
    expect(goals[goals.length - 1]).toBe("goal 4");
  });

  test("tracked-conversation cap evicts the oldest-inserted conversation", () => {
    for (let i = 0; i < 128; i++) {
      recordDedupReceipt(`conv-${i}`, "goal");
    }
    expect(hasDedupReceipt("conv-0")).toBe(true);

    recordDedupReceipt("conv-overflow", "goal");
    expect(hasDedupReceipt("conv-0")).toBe(false);
    expect(hasDedupReceipt("conv-1")).toBe(true);
    expect(hasDedupReceipt("conv-overflow")).toBe(true);
  });
});
