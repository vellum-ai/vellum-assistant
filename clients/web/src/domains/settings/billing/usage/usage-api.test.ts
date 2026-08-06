import { describe, expect, test } from "bun:test";

import {
  buildUsageBreakdownQuery,
  buildUsageDailyQuery,
  buildUsageSeriesQuery,
  buildUsageTotalsQuery,
} from "./usage-api";

describe("usage API query builders", () => {
  test("builds totals queries with a schedule filter", () => {
    expect(
      buildUsageTotalsQuery({
        from: 100,
        to: 200,
        scheduleId: "schedule-123",
      }),
    ).toEqual({
      from: 100,
      to: 200,
      scheduleId: "schedule-123",
    });
  });

  test("builds daily queries with existing params and a schedule filter", () => {
    expect(
      buildUsageDailyQuery({
        from: 100,
        to: 200,
        granularity: "hourly",
        tz: "America/New_York",
        scheduleId: "schedule-123",
      }),
    ).toEqual({
      from: 100,
      to: 200,
      granularity: "hourly",
      tz: "America/New_York",
      scheduleId: "schedule-123",
    });
  });

  test("preserves existing task/profile group-by translation", () => {
    expect(
      buildUsageBreakdownQuery({
        from: 100,
        to: 200,
        groupBy: "task",
      }),
    ).toEqual({
      from: 100,
      to: 200,
      groupBy: "call_site",
    });

    expect(
      buildUsageSeriesQuery({
        from: 100,
        to: 200,
        granularity: "daily",
        groupBy: "profile",
        tz: "UTC",
      }),
    ).toEqual({
      from: 100,
      to: 200,
      granularity: "daily",
      groupBy: "inference_profile",
      tz: "UTC",
    });
  });

  test("passes schedule group-by through unchanged with a schedule filter", () => {
    expect(
      buildUsageBreakdownQuery({
        from: 100,
        to: 200,
        groupBy: "schedule",
        scheduleId: "schedule-123",
      }),
    ).toEqual({
      from: 100,
      to: 200,
      groupBy: "schedule",
      scheduleId: "schedule-123",
    });

    expect(
      buildUsageSeriesQuery({
        from: 100,
        to: 200,
        granularity: "daily",
        groupBy: "schedule",
        tz: "UTC",
        scheduleId: "schedule-123",
      }),
    ).toEqual({
      from: 100,
      to: 200,
      granularity: "daily",
      groupBy: "schedule",
      tz: "UTC",
      scheduleId: "schedule-123",
    });
  });
});
