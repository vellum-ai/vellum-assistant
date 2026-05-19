import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";

import {
  UsageTrendChart,
  UsageTrendSkeleton,
} from "@/components/app/pages/LogsAndUsage/usage-trend-chart.js";
import type {
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

function bucket(overrides: Partial<UsageSeriesBucket> = {}): UsageSeriesBucket {
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

describe("UsageTrendChart", () => {
  test("renders existing empty-state copy", () => {
    const html = renderToStaticMarkup(
      <UsageTrendChart buckets={[]} isHourly={true} />,
    );

    expect(html).toContain("No hourly data");
    expect(html).toContain("No usage recorded in this time range");
  });

  test("renders stacked group segments and ungrouped fallback bars", () => {
    const html = renderToStaticMarkup(
      <UsageTrendChart
        isHourly={false}
        buckets={[
          bucket({
            bucketId: "2026-05-14",
            date: "2026-05-14",
            displayLabel: "May 14",
            totalEstimatedCostUsd: 10,
            groups: {
              modelA: groupValue("Model A", 6),
              modelB: groupValue("Model B", 4),
            },
          }),
          bucket({
            bucketId: "2026-05-15",
            date: "2026-05-15",
            displayLabel: "May 15",
            totalEstimatedCostUsd: 3,
            groups: {},
          }),
        ]}
      />,
    );

    expect(html).toContain('data-usage-series-bar="2026-05-14"');
    expect(html).toContain('data-usage-series-stack="2026-05-14"');
    expect(html).toContain('data-usage-series-segment="modelA"');
    expect(html).toContain('data-usage-series-segment-label="Model A"');
    expect(html).toContain('data-usage-series-segment="modelB"');
    expect(html).toContain('title="Model A: $6.00"');
    expect(html).toContain('data-usage-fallback-segment="true"');
    expect(html).toContain('data-usage-series-segment-label="Total"');
    expect(html).toContain("Model A");
    expect(html).toContain("Model B");
    expect(html).toContain("$10.00");
    expect(html).toContain("May 14");
    expect(html).toContain(
      "var(--usage-trend-stack-positive, var(--system-positive-strong, #10b981))",
    );
  });

  test("renders hourly skeleton bars with shared chart dimensions", () => {
    const html = renderToStaticMarkup(<UsageTrendSkeleton isHourly={true} />);

    expect(html).toContain("height:140px");
    expect(html).toContain("width:28px");
  });
});
