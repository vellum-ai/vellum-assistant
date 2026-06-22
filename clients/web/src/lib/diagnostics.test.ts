import { describe, expect, test } from "bun:test";

import { bucketMessagesAdded } from "@/lib/diagnostics";

describe("bucketMessagesAdded", () => {
  // Buckets must stay low-cardinality so the values are aggregable
  // as Sentry tags. Bands are chosen so 0 (no rescue) and 1 (single
  // missed message — the iOS watchdog shape) are distinguishable, and
  // larger rescues collapse into coarser buckets where the exact
  // count matters less than "this happened."
  test("returns '0' for no rescue", () => {
    expect(bucketMessagesAdded(0)).toBe("0");
  });

  test("returns '1' for the single-missed-message iOS watchdog shape", () => {
    expect(bucketMessagesAdded(1)).toBe("1");
  });

  test("collapses 2 through 5 into the '2-5' band", () => {
    expect(bucketMessagesAdded(2)).toBe("2-5");
    expect(bucketMessagesAdded(3)).toBe("2-5");
    expect(bucketMessagesAdded(5)).toBe("2-5");
  });

  test("collapses 6+ into the '6+' band", () => {
    expect(bucketMessagesAdded(6)).toBe("6+");
    expect(bucketMessagesAdded(42)).toBe("6+");
    expect(bucketMessagesAdded(1000)).toBe("6+");
  });

  test("treats negative counts as no-rescue rather than throwing", () => {
    // Defensive: instrumentation must never throw. A negative count
    // is theoretically impossible (next.length - prev.length where
    // next is reconciled) but we'd rather degrade to "0" than
    // surface a NaN tag value or crash.
    expect(bucketMessagesAdded(-1)).toBe("0");
  });

  test("treats NaN / Infinity as no-rescue rather than throwing", () => {
    // Non-finite values collapse to "0" so a corrupt input never
    // produces a meaningless tag value or crashes the call site.
    expect(bucketMessagesAdded(Number.NaN)).toBe("0");
    expect(bucketMessagesAdded(Number.POSITIVE_INFINITY)).toBe("0");
    expect(bucketMessagesAdded(Number.NEGATIVE_INFINITY)).toBe("0");
  });
});
