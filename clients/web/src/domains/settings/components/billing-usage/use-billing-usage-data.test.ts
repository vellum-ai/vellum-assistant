import { afterEach, describe, expect, mock, test } from "bun:test";

import {
  computeRangeInTimezone,
  presetDaysFromRange,
} from "@/components/charts/date-range-select";

import {
  buildBillingUsageSeriesQuery,
  buildBillingUsageTotalsQuery,
  getDefaultDateRange,
  isBillingUsageDataEnabled,
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

describe("isBillingUsageDataEnabled", () => {
  // Signature: (platformGate, reachabilityGate, isPlatformHosted).
  test("enables the queries only for a positively-resolved platform-hosted assistant with the platform API reachable", () => {
    expect(isBillingUsageDataEnabled("full", "full", true)).toBe(true);
  });

  test("stays disabled while the gate is 'full' but hosting is not yet resolved", () => {
    // The platformHostedOnly gate reports "full" during the lifecycle loading
    // window; the strict isPlatformHosted check is what blocks a doomed fetch.
    expect(isBillingUsageDataEnabled("full", "full", false)).toBe(false);
  });

  test("stays disabled when the platform API is unreachable (VELLUM_DISABLE_PLATFORM)", () => {
    // platformHostedOnly ignores VELLUM_DISABLE_PLATFORM and can report "full"
    // for a platform-hosted assistant even when platformFeaturesGate aborts the
    // request. The reachability gate ("gated") is what prevents the doomed
    // fetch and keeps the chart hidden, matching how the Billing tab hides
    // itself for the same state.
    expect(isBillingUsageDataEnabled("full", "gated", true)).toBe(false);
  });

  test("stays disabled for a self-hosted assistant (gate 'gated')", () => {
    expect(isBillingUsageDataEnabled("gated", "gated", false)).toBe(false);
    expect(isBillingUsageDataEnabled("gated", "gated", true)).toBe(false);
  });

  test("stays disabled with no platform session (gate 'disabled')", () => {
    expect(isBillingUsageDataEnabled("disabled", "disabled", false)).toBe(false);
    expect(isBillingUsageDataEnabled("disabled", "disabled", true)).toBe(false);
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

describe("presetDaysFromRange", () => {
  for (const days of [7, 30, 90]) {
    test(`maps a ${days}-day range back to its preset identity`, () => {
      expect(presetDaysFromRange(computeRangeInTimezone(days))).toBe(days);
    });
  }

  test("falls back to the 30-day default for a non-preset span", () => {
    // 45 days apart matches none of the 7/30/90 presets.
    expect(presetDaysFromRange({ from: "2025-12-01", to: "2026-01-14" })).toBe(
      30,
    );
  });
});

describe("preset identity → range derivation (tz change)", () => {
  // The panel stores the preset identity (days) and derives bounds from that
  // identity + the live tz. This is what makes a tz change recompute the
  // ACTIVE preset correctly, even across a calendar-day rollover.
  //
  // Pacific/Kiritimati (UTC+14) and Pacific/Niue (UTC-11) sit a full calendar
  // day apart at most instants, so a preset's bounds differ between the zones.
  const EAST = "Pacific/Kiritimati";
  const WEST = "Pacific/Niue";

  for (const days of [7, 30, 90]) {
    test(`deriving the ${days}-day preset by identity yields new-tz bounds`, () => {
      // The range the panel was showing before the tz change. Its bounds are
      // irrelevant to the new computation — only the stored identity matters.
      const beforeTzChange = computeRangeInTimezone(days, EAST);
      // On tz change the panel recomputes from identity (days) + new tz.
      const afterTzChange = computeRangeInTimezone(days, WEST);

      expect(afterTzChange).toEqual(computeRangeInTimezone(days, WEST));
      // The two zones sit a calendar day apart, so the bounds actually moved —
      // proving the derivation followed the new tz rather than the stale range.
      expect(afterTzChange).not.toEqual(beforeTzChange);
    });
  }

  test("rollover: a stale prior-day range is ignored, identity wins", () => {
    // Simulate the bug's setup: the active range was computed on a PRIOR
    // calendar day (a fixed, now-stale 7-day range). Reverse-matching this
    // against freshly recomputed prev-tz bounds would fail and strand it as
    // "custom". Deriving from the stored identity (7) sidesteps that entirely.
    const stalePriorDayRange = { from: "2026-01-01", to: "2026-01-07" };
    const presetDays = presetDaysFromRange(stalePriorDayRange); // 7

    const recomputed = computeRangeInTimezone(presetDays, WEST);

    expect(daysApart(recomputed.from, recomputed.to)).toBe(7);
    expect(recomputed).toEqual(computeRangeInTimezone(7, WEST));
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
