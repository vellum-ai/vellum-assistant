import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { UsageTrendChart } from "@/domains/logs/components/usage-trend-chart";
import { usageSeriesKeyForGroupValue } from "@/domains/logs/usage-series";
import type { UsageSeriesBucket } from "@/domains/logs/usage-types";

afterEach(() => {
  cleanup();
});

function bucket(
  bucketId: string,
  totalEstimatedCostUsd: number,
  groups: UsageSeriesBucket["groups"],
): UsageSeriesBucket {
  return {
    bucketId,
    date: bucketId,
    displayLabel: bucketId,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalEstimatedCostUsd,
    eventCount: 1,
    groups,
  };
}

function group(
  label: string,
  groupKey: string | null,
  totalEstimatedCostUsd: number,
): UsageSeriesBucket["groups"][string] {
  return {
    group: label,
    groupKey,
    totalInputTokens: 100,
    totalOutputTokens: 50,
    totalEstimatedCostUsd,
    eventCount: 1,
  };
}

describe("usageSeriesKeyForGroupValue", () => {
  test("matches the backend grouped-series key convention", () => {
    expect(usageSeriesKeyForGroupValue("schedule-123")).toBe(
      "value:schedule-123",
    );
    expect(usageSeriesKeyForGroupValue(null, "schedule")).toBe(
      "null:schedule",
    );
    expect(usageSeriesKeyForGroupValue("null:schedule")).toBe(
      "value:null:schedule",
    );
  });
});

describe("UsageTrendChart", () => {
  test("renders the bucket-derived legend as active by default", () => {
    const buckets = [
      bucket("2026-04-01", 0.03, {
        "value:schedule-a": group("Alpha schedule", "schedule-a", 0.01),
        "value:schedule-b": group("Beta schedule", "schedule-b", 0.02),
      }),
    ];

    const { getByText, container } = render(
      <UsageTrendChart buckets={buckets} isHourly={false} />,
    );

    const legendItems = Array.from(
      container.querySelectorAll("[data-usage-legend-state]"),
    );
    expect(legendItems.map((item) => item.textContent)).toEqual([
      "Beta schedule",
      "Alpha schedule",
    ]);
    expect(
      legendItems.map((item) =>
        item.getAttribute("data-usage-legend-state"),
      ),
    ).toEqual(["active", "active"]);
    expect(getByText("Beta schedule").className).not.toContain("line-through");
  });

  test("renders selected-series legend overrides with inactive entries", () => {
    const activeSeriesKey = "value:schedule-a";
    const inactiveSeriesKey = "value:schedule-b";
    const buckets = [
      bucket("2026-04-01", 0.01, {
        [activeSeriesKey]: group("Alpha schedule", "schedule-a", 0.01),
      }),
    ];

    const { getByText, container } = render(
      <UsageTrendChart
        buckets={buckets}
        isHourly={false}
        legendItems={[
          {
            seriesKey: inactiveSeriesKey,
            label: "Beta schedule",
            totalEstimatedCostUsd: 0,
            colorIndex: 0,
            state: "inactive",
          },
          {
            seriesKey: activeSeriesKey,
            label: "Alpha schedule",
            totalEstimatedCostUsd: 0.01,
            colorIndex: 1,
            state: "active",
          },
        ]}
      />,
    );

    const inactiveLabel = getByText("Beta schedule");
    const inactiveItem = inactiveLabel.closest("[data-usage-legend-state]");
    expect(inactiveItem?.getAttribute("data-usage-legend-state")).toBe(
      "inactive",
    );
    expect(inactiveLabel.className).toContain("line-through");
    const inactiveSegment = container.querySelector(
      `[data-usage-series-segment="${inactiveSeriesKey}"]`,
    );
    expect(inactiveSegment).toBeNull();

    const activeLabel = getByText("Alpha schedule");
    const activeItem = activeLabel.closest("[data-usage-legend-state]");
    expect(activeItem?.getAttribute("data-usage-legend-state")).toBe("active");
    expect(activeLabel.className).not.toContain("line-through");

    const activeDot = activeItem!.querySelector("[aria-hidden='true']");
    const activeSegment = container.querySelector(
      `[data-usage-series-segment="${activeSeriesKey}"]`,
    );
    expect(activeDot).not.toBeNull();
    expect(activeSegment).not.toBeNull();
    expect(activeSegment!.getAttribute("data-usage-series-color-index")).toBe(
      activeDot!.getAttribute("data-usage-series-color-index"),
    );
  });
});
