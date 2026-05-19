import { describe, expect, test } from "bun:test";

import {
  buildUsageSeriesLegend,
  decorateUsageSeriesGroups,
  seriesFromDailyBuckets,
  sortUsageSeriesBuckets,
} from "@/components/app/pages/LogsAndUsage/usage-series.js";
import type {
  UsageDayBucket,
  UsageSeriesBucket,
  UsageSeriesGroupValue,
} from "@/lib/usage/types.js";

function groupValue(
  group: string,
  cost: number,
  overrides: Partial<UsageSeriesGroupValue> = {},
): UsageSeriesGroupValue {
  return {
    group,
    groupKey: group,
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalEstimatedCostUsd: cost,
    eventCount: 2,
    ...overrides,
  };
}

function seriesBucket(
  overrides: Partial<UsageSeriesBucket> = {},
): UsageSeriesBucket {
  return {
    bucketId: "2026-05-14",
    date: "2026-05-14",
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalEstimatedCostUsd: 0.12,
    eventCount: 2,
    groups: {},
    ...overrides,
  };
}

function dailyBucket(overrides: Partial<UsageDayBucket> = {}): UsageDayBucket {
  return {
    bucketId: "2026-05-14",
    date: "2026-05-14",
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalEstimatedCostUsd: 0.12,
    eventCount: 2,
    ...overrides,
  };
}

describe("sortUsageSeriesBuckets", () => {
  test("sorts by date, then duplicate-hour higher UTC offset first, then bucket id", () => {
    const sorted = sortUsageSeriesBuckets([
      seriesBucket({
        bucketId: "2026-11-01 01:00|-480",
        date: "2026-11-01 01:00",
      }),
      seriesBucket({
        bucketId: "2026-11-01 00:00|-420",
        date: "2026-11-01 00:00",
      }),
      seriesBucket({
        bucketId: "2026-11-01 01:00|-420",
        date: "2026-11-01 01:00",
      }),
      seriesBucket({
        bucketId: "fallback-bucket-b",
        date: "2026-11-01 02:00",
      }),
      seriesBucket({
        bucketId: "fallback-bucket-a",
        date: "2026-11-01 02:00",
      }),
    ]);

    expect(sorted.map((bucket) => bucket.bucketId)).toEqual([
      "2026-11-01 00:00|-420",
      "2026-11-01 01:00|-420",
      "2026-11-01 01:00|-480",
      "fallback-bucket-a",
      "fallback-bucket-b",
    ]);
  });
});

describe("seriesFromDailyBuckets", () => {
  test("converts ungrouped daily buckets into series buckets", () => {
    expect(
      seriesFromDailyBuckets([
        dailyBucket({
          bucketId: "2026-05-14",
          date: "2026-05-14",
          displayLabel: "May 14",
          totalEstimatedCostUsd: 0.34,
        }),
      ]),
    ).toEqual([
      {
        bucketId: "2026-05-14",
        date: "2026-05-14",
        displayLabel: "May 14",
        totalInputTokens: 10,
        totalOutputTokens: 20,
        totalEstimatedCostUsd: 0.34,
        eventCount: 2,
        groups: {},
      },
    ]);
  });
});

describe("buildUsageSeriesLegend", () => {
  test("sorts groups by total cost, applies label tie-breaks, and limits visible labels", () => {
    const legend = buildUsageSeriesLegend([
      seriesBucket({
        groups: {
          bravo: groupValue("Bravo", 4),
          alpha: groupValue("Alpha", 4),
          charlie: groupValue("Charlie", 9),
          delta: groupValue("Delta", 3),
          echo: groupValue("Echo", 2),
          foxtrot: groupValue("Foxtrot", 1),
          golf: groupValue("Golf", 0.5),
        },
      }),
      seriesBucket({
        bucketId: "2026-05-15",
        date: "2026-05-15",
        groups: {
          delta: groupValue("Delta", 2),
          golf: groupValue("Golf", 0.25),
        },
      }),
    ]);

    expect(
      legend.items.map((item) => [
        item.seriesKey,
        item.label,
        item.totalEstimatedCostUsd,
        item.colorIndex,
      ]),
    ).toEqual([
      ["charlie", "Charlie", 9, 0],
      ["delta", "Delta", 5, 1],
      ["alpha", "Alpha", 4, 2],
      ["bravo", "Bravo", 4, 3],
      ["echo", "Echo", 2, 4],
      ["foxtrot", "Foxtrot", 1, 5],
      ["golf", "Golf", 0.75, 6],
    ]);
    expect(legend.visibleItems.map((item) => item.label)).toEqual([
      "Charlie",
      "Delta",
      "Alpha",
      "Bravo",
      "Echo",
      "Foxtrot",
    ]);
  });
});

describe("decorateUsageSeriesGroups", () => {
  test("applies call-site and profile metadata labels to series groups", () => {
    const taskBucket = seriesBucket({
      groups: {
        "call-site:mainAgent": groupValue("mainAgent", 1, {
          groupKey: "mainAgent",
        }),
      },
    });
    const profileBucket = seriesBucket({
      groups: {
        "profile:quality": groupValue("quality-optimized", 1, {
          groupKey: "quality-optimized",
        }),
      },
    });

    expect(
      decorateUsageSeriesGroups([taskBucket], "task", {
        callSites: {
          mainAgent: {
            id: "mainAgent",
            displayName: "Main Agent",
            description: "",
            domain: "",
          },
        },
      })[0]?.groups["call-site:mainAgent"]?.group,
    ).toBe("Main Agent");

    expect(
      decorateUsageSeriesGroups([profileBucket], "profile", {
        profiles: {
          "quality-optimized": {
            id: "quality-optimized",
            displayName: "Quality",
          },
        },
      })[0]?.groups["profile:quality"]?.group,
    ).toBe("Quality");
  });

  test("skips metadata decoration for groupings without external labels", () => {
    const bucket = seriesBucket({
      groups: {
        model: groupValue("claude-sonnet-4-5", 1),
      },
    });

    const decorated = decorateUsageSeriesGroups([bucket], "model", {
      callSites: {
        "claude-sonnet-4-5": {
          id: "claude-sonnet-4-5",
          displayName: "Should Not Apply",
          description: "",
          domain: "",
        },
      },
    });

    expect(decorated).toEqual([bucket]);
    expect(decorated[0]).toBe(bucket);
  });
});
