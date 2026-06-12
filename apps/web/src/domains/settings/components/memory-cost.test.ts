import { describe, expect, test } from "bun:test";

import {
  formatMemoryCostUsd,
  sumMemoryCallSiteCostUsd,
} from "@/domains/settings/components/memory-cost";

const CALL_SITES = [
  { id: "mainAgent", domain: "agentLoop" },
  { id: "memoryExtraction", domain: "memory" },
  { id: "memoryRetrospective", domain: "memory" },
  { id: "conversationTitle", domain: "ui" },
];

describe("sumMemoryCallSiteCostUsd", () => {
  test("sums only rows attributed to memory-domain call sites", () => {
    const total = sumMemoryCallSiteCostUsd(
      [
        { groupKey: "mainAgent", totalEstimatedCostUsd: 10 },
        { groupKey: "memoryExtraction", totalEstimatedCostUsd: 0.25 },
        { groupKey: "memoryRetrospective", totalEstimatedCostUsd: 0.5 },
        { groupKey: "conversationTitle", totalEstimatedCostUsd: 1 },
      ],
      CALL_SITES,
    );
    expect(total).toBeCloseTo(0.75);
  });

  test("excludes rows without call-site attribution", () => {
    const total = sumMemoryCallSiteCostUsd(
      [
        { groupKey: null, totalEstimatedCostUsd: 5 },
        { totalEstimatedCostUsd: 5 },
        { groupKey: "memoryExtraction", totalEstimatedCostUsd: 0.1 },
      ],
      CALL_SITES,
    );
    expect(total).toBeCloseTo(0.1);
  });

  test("ignores call sites the catalog does not know about", () => {
    const total = sumMemoryCallSiteCostUsd(
      [{ groupKey: "futureMemoryThing", totalEstimatedCostUsd: 2 }],
      CALL_SITES,
    );
    expect(total).toBe(0);
  });

  test("returns 0 for an empty breakdown", () => {
    expect(sumMemoryCallSiteCostUsd([], CALL_SITES)).toBe(0);
  });
});

describe("formatMemoryCostUsd", () => {
  test("renders zero as $0.00", () => {
    expect(formatMemoryCostUsd(0)).toBe("$0.00");
  });

  test("renders sub-cent costs without rounding to zero", () => {
    expect(formatMemoryCostUsd(0.0042)).toBe("Less than $0.01");
  });

  test("renders cents and dollars with two decimals", () => {
    expect(formatMemoryCostUsd(0.25)).toBe("$0.25");
    expect(formatMemoryCostUsd(12.345)).toBe("$12.35");
  });

  test("treats non-finite input as zero", () => {
    expect(formatMemoryCostUsd(Number.NaN)).toBe("$0.00");
  });
});
