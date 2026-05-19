import { describe, expect, test } from "bun:test";

import {
  formatBreakdownTokens,
  formatBreakdownTokensShort,
} from "@/components/app/pages/LogsAndUsage/usage-breakdown-format.js";
import type { UsageGroupBreakdown } from "@/lib/usage/types.js";

function breakdown(
  overrides: Partial<UsageGroupBreakdown> = {},
): UsageGroupBreakdown {
  return {
    group: "Main Agent",
    groupId: "main-agent",
    totalInputTokens: 0,
    totalOutputTokens: 0,
    totalCacheCreationTokens: 0,
    totalCacheReadTokens: 0,
    totalEstimatedCostUsd: 0,
    eventCount: 0,
    ...overrides,
  };
}

describe("formatBreakdownTokens", () => {
  test("matches the macOS breakdown summary wording and order", () => {
    expect(
      formatBreakdownTokens(
        breakdown({
          totalInputTokens: 1_234,
          totalCacheCreationTokens: 78,
          totalCacheReadTokens: 9_876,
          totalOutputTokens: 56,
        }),
      ),
    ).toBe("1,234 direct / 78 cache created / 9,876 cache read / 56 out");
  });

  test("always includes all four token classes", () => {
    expect(formatBreakdownTokens(breakdown())).toBe(
      "0 direct / 0 cache created / 0 cache read / 0 out",
    );
  });

  test("does not append event count to the token summary", () => {
    expect(
      formatBreakdownTokens(
        breakdown({
          totalInputTokens: 1,
          totalOutputTokens: 2,
          eventCount: 99,
        }),
      ),
    ).toBe("1 direct / 0 cache created / 0 cache read / 2 out");
  });
});

describe("formatBreakdownTokensShort", () => {
  test("sums input tokens across direct, cache created, and cache read", () => {
    expect(
      formatBreakdownTokensShort(
        breakdown({
          totalInputTokens: 100,
          totalCacheCreationTokens: 50,
          totalCacheReadTokens: 50,
          totalOutputTokens: 200,
        }),
      ),
    ).toBe("200 in / 200 out");
  });

  test("abbreviates values >= 1000 with k suffix", () => {
    expect(
      formatBreakdownTokensShort(
        breakdown({
          totalInputTokens: 1_234,
          totalOutputTokens: 5_678,
        }),
      ),
    ).toBe("1.2k in / 5.7k out");
  });

  test("abbreviates values >= 1M with M suffix", () => {
    expect(
      formatBreakdownTokensShort(
        breakdown({
          totalInputTokens: 2_500_000,
          totalOutputTokens: 1_000_000,
        }),
      ),
    ).toBe("2.5M in / 1.0M out");
  });

  test("promotes to M when k-tier rounding overflows to 1000.0k", () => {
    expect(
      formatBreakdownTokensShort(
        breakdown({ totalInputTokens: 999_950, totalOutputTokens: 999_999 }),
      ),
    ).toBe("1.0M in / 1.0M out");
  });

  test("shows zero for zero tokens", () => {
    expect(formatBreakdownTokensShort(breakdown())).toBe("0 in / 0 out");
  });

  test("handles small values without abbreviation", () => {
    expect(
      formatBreakdownTokensShort(
        breakdown({ totalInputTokens: 42, totalOutputTokens: 7 }),
      ),
    ).toBe("42 in / 7 out");
  });
});
