import { describe, expect, test } from "bun:test";

import {
  DEFAULT_USAGE_GROUP_BY,
  FALLBACK_USAGE_GROUP_BY,
  resolveEffectiveUsageGranularity,
  shouldFallbackUsageGroupBy,
  shouldFetchUsageSeries,
  shouldRetryUsageGroupQuery,
  trendTitle,
  USAGE_GROUP_BY_OPTIONS,
} from "@/components/app/pages/LogsAndUsage/usage-tab-state.js";
import { ApiError } from "@/lib/api/errors.js";
import type { UsageGroupBy } from "@/lib/usage/types.js";

describe("usage tab state", () => {
  test("defaults to Action", () => {
    expect(DEFAULT_USAGE_GROUP_BY).toBe("task");
    expect(FALLBACK_USAGE_GROUP_BY).toBe("model");
  });

  test("orders the primary picker options without legacy actor", () => {
    expect(USAGE_GROUP_BY_OPTIONS).toEqual([
      { value: "task", label: "Action" },
      { value: "profile", label: "Profile" },
      { value: "model", label: "Model" },
      { value: "provider", label: "Provider" },
      { value: "conversation", label: "Conversation" },
    ]);
  });

  test("fetches grouped series for every selectable grouping except conversation", () => {
    const values: UsageGroupBy[] = [
      "task",
      "profile",
      "model",
      "provider",
      "actor",
    ];

    for (const value of values) {
      expect(shouldFetchUsageSeries(value)).toBe(true);
    }
    expect(shouldFetchUsageSeries("conversation")).toBe(false);
  });

  test("builds trend titles from granularity and selected grouping", () => {
    expect(trendTitle("daily", "task")).toBe("Daily Trend by Action");
    expect(trendTitle("hourly", "profile")).toBe("Hourly Trend by Profile");
    expect(trendTitle("daily", "model")).toBe("Daily Trend by Model");
    expect(trendTitle("hourly", "provider")).toBe(
      "Hourly Trend by Provider",
    );
    expect(trendTitle("daily", "actor")).toBe("Daily Trend by Actor");
    expect(trendTitle("daily", "conversation")).toBe("Daily Trend");
    expect(trendTitle("daily", undefined)).toBe("Daily Trend");
  });

  test("falls back from Action/Profile only on unsupported group errors", () => {
    for (const status of [400, 404, 422]) {
      expect(
        shouldFallbackUsageGroupBy(
          "task",
          new ApiError(status, "unsupported group"),
        ),
      ).toBe(true);
      expect(
        shouldFallbackUsageGroupBy(
          "profile",
          new ApiError(status, "unsupported group"),
        ),
      ).toBe(true);
    }

    expect(
      shouldFallbackUsageGroupBy("task", new ApiError(500, "server error")),
    ).toBe(false);
    expect(
      shouldFallbackUsageGroupBy("model", new ApiError(400, "bad group")),
    ).toBe(false);
    expect(shouldFallbackUsageGroupBy("profile", new Error("network"))).toBe(
      false,
    );
  });

  test("does not retry unsupported group errors before fallback", () => {
    expect(
      shouldRetryUsageGroupQuery(0, new ApiError(400, "unsupported group")),
    ).toBe(false);
    expect(
      shouldRetryUsageGroupQuery(0, new ApiError(404, "unsupported group")),
    ).toBe(false);
    expect(
      shouldRetryUsageGroupQuery(0, new ApiError(422, "unsupported group")),
    ).toBe(false);

    expect(shouldRetryUsageGroupQuery(0, new ApiError(500, "server"))).toBe(
      true,
    );
    expect(shouldRetryUsageGroupQuery(3, new ApiError(500, "server"))).toBe(
      false,
    );
    expect(shouldRetryUsageGroupQuery(0, new Error("network"))).toBe(true);
  });

  test("keeps hourly presentation while Today is loading or empty", () => {
    expect(
      resolveEffectiveUsageGranularity({
        requestedGranularity: "hourly",
        isLoading: true,
        buckets: undefined,
      }),
    ).toBe("hourly");
    expect(
      resolveEffectiveUsageGranularity({
        requestedGranularity: "hourly",
        isLoading: false,
        buckets: [],
      }),
    ).toBe("hourly");
  });

  test("falls back to daily presentation for older daemons returning daily buckets", () => {
    expect(
      resolveEffectiveUsageGranularity({
        requestedGranularity: "hourly",
        isLoading: false,
        buckets: [{ bucketId: "2026-05-14", date: "2026-05-14" }],
      }),
    ).toBe("daily");
  });

  test("detects hourly bucket shapes", () => {
    expect(
      resolveEffectiveUsageGranularity({
        requestedGranularity: "hourly",
        isLoading: false,
        buckets: [{ bucketId: "2026-05-14 10:00|-360", date: "2026-05-14" }],
      }),
    ).toBe("hourly");
    expect(
      resolveEffectiveUsageGranularity({
        requestedGranularity: "hourly",
        isLoading: false,
        buckets: [{ bucketId: "fallback", date: "2026-05-14 10:00" }],
      }),
    ).toBe("hourly");
  });
});
