import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  buildBillingUsageSeriesQuery,
  buildBillingUsageTotalsQuery,
  type UsageChartState,
} from "./use-billing-usage-data";

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
