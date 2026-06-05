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
    expect(usageSeriesKeyForGroupValue(null, "task")).toBe("null:call_site");
    expect(usageSeriesKeyForGroupValue(null, "profile")).toBe(
      "null:inference_profile",
    );
    expect(usageSeriesKeyForGroupValue("null:schedule")).toBe(
      "value:null:schedule",
    );
    expect(usageSeriesKeyForGroupValue("profile-123", "profile")).toBe(
      "value:profile-123",
    );
  });
});

describe("UsageTrendChart", () => {
  test("renders selected-series legend overrides in the empty state", () => {
    const { container, getByText } = render(
      <UsageTrendChart
        buckets={[]}
        isHourly={false}
        legendItems={[
          {
            seriesKey: "value:schedule-123",
            label: "Morning digest",
            colorIndex: 0,
            state: "active",
          },
          {
            seriesKey: "value:schedule-456",
            label: "Evening digest",
            colorIndex: 1,
            state: "inactive",
          },
        ]}
      />,
    );

    expect(getByText("No daily data")).toBeTruthy();
    const legendItems = Array.from(
      container.querySelectorAll("[data-usage-legend-state]"),
    );
    expect(legendItems.map((item) => item.textContent)).toEqual([
      "Morning digest",
      "Evening digest",
    ]);
    expect(
      legendItems.map((item) =>
        item.getAttribute("data-usage-legend-state"),
      ),
    ).toEqual(["active", "inactive"]);

    const activeLabel = getByText("Morning digest");
    const inactiveLabel = getByText("Evening digest");
    expect(activeLabel.className).not.toContain("line-through");
    expect(inactiveLabel.className).toContain("line-through");
  });

  test("keeps the default empty state legend-free without overrides", () => {
    const { container, getByText } = render(
      <UsageTrendChart buckets={[]} isHourly={false} />,
    );

    expect(getByText("No daily data")).toBeTruthy();
    expect(container.querySelector("[data-usage-legend-state]")).toBeNull();
  });

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
      bucket("2026-04-01", 0.03, {
        [activeSeriesKey]: group("Alpha schedule", "schedule-a", 0.01),
        [inactiveSeriesKey]: group("Beta schedule", "schedule-b", 0.02),
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
            colorIndex: 0,
            state: "inactive",
          },
          {
            seriesKey: activeSeriesKey,
            label: "Alpha schedule",
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
    expect(
      container.querySelectorAll("[data-usage-series-segment]"),
    ).toHaveLength(1);

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

  test("does not render a fallback segment when selected active series have no bucket data", () => {
    const activeSeriesKey = "value:schedule-a";
    const inactiveSeriesKey = "value:schedule-b";
    const buckets = [
      bucket("2026-04-01", 0.02, {
        [inactiveSeriesKey]: group("Beta schedule", "schedule-b", 0.02),
      }),
    ];

    const { container } = render(
      <UsageTrendChart
        buckets={buckets}
        isHourly={false}
        legendItems={[
          {
            seriesKey: inactiveSeriesKey,
            label: "Beta schedule",
            colorIndex: 0,
            state: "inactive",
          },
          {
            seriesKey: activeSeriesKey,
            label: "Alpha schedule",
            colorIndex: 1,
            state: "active",
          },
        ]}
      />,
    );

    const bar = container.querySelector(
      `[data-usage-series-bar="${buckets[0]!.bucketId}"]`,
    );
    expect(bar).not.toBeNull();
    expect(bar!.querySelector("[data-usage-fallback-segment]")).toBeNull();
    expect(bar!.querySelector("[data-usage-series-segment]")).toBeNull();
    expect(
      bar!.querySelector(
        `[data-usage-series-segment="${activeSeriesKey}"]`,
      ),
    ).toBeNull();
  });

  test("does not render a fallback segment for empty grouped buckets with a legend override", () => {
    const activeSeriesKey = "value:schedule-a";
    const buckets = [bucket("2026-04-01", 0.02, {})];

    const { container } = render(
      <UsageTrendChart
        buckets={buckets}
        isHourly={false}
        legendItems={[
          {
            seriesKey: activeSeriesKey,
            label: "Alpha schedule",
            colorIndex: 0,
            state: "active",
          },
        ]}
      />,
    );

    const bar = container.querySelector(
      `[data-usage-series-bar="${buckets[0]!.bucketId}"]`,
    );
    expect(bar).not.toBeNull();
    expect(bar!.querySelector("[data-usage-fallback-segment]")).toBeNull();
    expect(bar!.querySelector("[data-usage-series-segment]")).toBeNull();
  });

  test("renders the total fallback segment for ungrouped buckets", () => {
    const buckets = [bucket("2026-04-01", 0.02, {})];

    const { container } = render(
      <UsageTrendChart buckets={buckets} isHourly={false} />,
    );

    const bar = container.querySelector(
      `[data-usage-series-bar="${buckets[0]!.bucketId}"]`,
    );
    const fallbackSegment = bar?.querySelector(
      "[data-usage-fallback-segment]",
    );
    expect(fallbackSegment).not.toBeNull();
    expect(
      fallbackSegment?.getAttribute("data-usage-series-segment-label"),
    ).toBe("Total");
  });
});
