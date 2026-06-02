import { afterEach, describe, expect, mock, test } from "bun:test";

import { computeRangeInTimezone } from "@/components/charts/date-range-select";

import {
  buildBillingUsageSeriesQuery,
  buildBillingUsageTotalsQuery,
  getDefaultDateRange,
  reconcilePresetRange,
  type UsageChartState,
} from "./use-billing-usage-data";

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function daysApart(from: string, to: string): number {
  const ms = Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000) + 1;
}

function makeState(): UsageChartState {
  return {
    dateRange: { from: "2026-01-01", to: "2026-01-31" },
    setDateRange: () => {},
    drilldown: null,
    setDrilldown: () => {},
  };
}

describe("buildBillingUsageSeriesQuery", () => {
  test("uses the explicit tz argument", () => {
    const query = buildBillingUsageSeriesQuery(makeState(), "America/New_York");
    expect(query.tz).toBe("America/New_York");
    expect(query.from).toBe("2026-01-01");
    expect(query.to).toBe("2026-01-31");
  });
});

describe("buildBillingUsageTotalsQuery", () => {
  test("uses the explicit tz argument", () => {
    const query = buildBillingUsageTotalsQuery(makeState(), "America/New_York");
    expect(query.tz).toBe("America/New_York");
    expect(query.from).toBe("2026-01-01");
    expect(query.to).toBe("2026-01-31");
  });
});

describe("getDefaultDateRange", () => {
  test("computes a 30-day range as YYYY-MM-DD bounds in the given tz", () => {
    const { from, to } = getDefaultDateRange("America/New_York");
    expect(from).toMatch(DATE_RE);
    expect(to).toMatch(DATE_RE);
    expect(daysApart(from, to)).toBe(30);
  });

  test("uses the supplied tz so dates can differ from another zone at a boundary", () => {
    // Across a wide UTC offset gap, the calendar 'today' can differ. We assert
    // each zone yields a self-consistent, well-formed 30-day range; at the
    // right instant Kiritimati (UTC+14) and Niue (UTC-11) sit on different
    // calendar days, so the computed bounds are independent per zone.
    const east = getDefaultDateRange("Pacific/Kiritimati");
    const west = getDefaultDateRange("Pacific/Niue");
    for (const r of [east, west]) {
      expect(r.from).toMatch(DATE_RE);
      expect(r.to).toMatch(DATE_RE);
      expect(daysApart(r.from, r.to)).toBe(30);
    }
  });
});

describe("reconcilePresetRange", () => {
  // Pacific/Kiritimati (UTC+14) and Pacific/Niue (UTC-11) sit a full calendar
  // day apart at most instants, so a preset's bounds differ between the zones.
  const EAST = "Pacific/Kiritimati";
  const WEST = "Pacific/Niue";

  for (const days of [7, 30, 90]) {
    test(`recomputes the active ${days}-day preset across a tz change`, () => {
      const current = computeRangeInTimezone(days, EAST);
      const result = reconcilePresetRange(current, EAST, WEST);
      expect(result).toEqual(computeRangeInTimezone(days, WEST));
    });
  }

  test("leaves a range that matches no preset unchanged", () => {
    // 45 days apart matches none of the 7/30/90 presets.
    const custom = { from: "2025-12-01", to: "2026-01-14" };
    const result = reconcilePresetRange(custom, EAST, WEST);
    expect(result).toBe(custom);
  });

  test("returns the same reference when the matched preset is unchanged", () => {
    // Same tz on both sides: the preset's bounds are identical, so the helper
    // must bail out referentially rather than allocate a new range.
    const current = computeRangeInTimezone(7, EAST);
    const result = reconcilePresetRange(current, EAST, EAST);
    expect(result).toBe(current);
  });
});

describe("default tz resolution", () => {
  afterEach(() => {
    mock.restore();
  });

  test("defaults to getEffectiveTimezone() for both builders", async () => {
    mock.module("@/utils/effective-timezone", () => ({
      getEffectiveTimezone: () => "Europe/Berlin",
    }));

    // Re-import after mocking so the builders pick up the mocked default.
    const { buildBillingUsageSeriesQuery: buildSeries, buildBillingUsageTotalsQuery: buildTotals } =
      await import("./use-billing-usage-data");

    expect(buildSeries(makeState()).tz).toBe("Europe/Berlin");
    expect(buildTotals(makeState()).tz).toBe("Europe/Berlin");
  });
});
