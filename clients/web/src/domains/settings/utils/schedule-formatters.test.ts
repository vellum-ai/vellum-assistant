import { describe, expect, test, beforeEach } from "bun:test";

import type { ScheduleUsageSummary } from "@/domains/settings/types/schedules";
import { changeLocale, initI18n } from "@/i18n";

import {
  consolidationSubtitle,
  formatInterval,
  heartbeatSubtitle,
  retrospectiveSubtitle,
  systemTaskUsageCost,
  totalUsageCost,
} from "./schedule-formatters";

function summary(
  scheduleId: string,
  totalEstimatedCostUsd: number,
): ScheduleUsageSummary {
  return {
    scheduleId,
    runCount: 1,
    totalEstimatedCostUsd,
    eventCount: 0,
  };
}

describe("totalUsageCost", () => {
  test("returns 0 for an empty array", () => {
    expect(totalUsageCost([])).toBe(0);
  });

  test("returns 0 for undefined", () => {
    expect(totalUsageCost(undefined)).toBe(0);
  });

  test("sums totalEstimatedCostUsd across multiple summaries", () => {
    expect(
      totalUsageCost([summary("a", 1.25), summary("b", 2.5), summary("c", 0)]),
    ).toBeCloseTo(3.75);
  });

  test("skips non-finite cost entries", () => {
    expect(
      totalUsageCost([
        summary("a", 1),
        summary("b", Number.NaN),
        summary("c", Infinity),
        summary("d", -Infinity),
        summary("e", 2),
      ]),
    ).toBe(3);
  });
});

describe("systemTaskUsageCost", () => {
  test("returns 0 while loading", () => {
    expect(systemTaskUsageCost({ status: "loading" })).toBe(0);
  });

  test("returns 0 on error", () => {
    expect(systemTaskUsageCost({ status: "error" })).toBe(0);
  });

  test("returns the summary cost when ready", () => {
    expect(
      systemTaskUsageCost({ status: "ready", summary: summary("a", 4.5) }),
    ).toBe(4.5);
  });

  test("returns 0 when ready summary cost is falsy", () => {
    expect(
      systemTaskUsageCost({ status: "ready", summary: summary("a", 0) }),
    ).toBe(0);
  });
});

describe("heartbeatSubtitle", () => {
  beforeEach(async () => {
    await initI18n();
    await changeLocale("en");
  });

  test("appends active hours without a zone when none is known", () => {
    expect(
      heartbeatSubtitle({
        enabled: true,
        intervalMs: 3_600_000,
        activeHoursStart: 8,
        activeHoursEnd: 22,
        cronExpression: null,
        timezone: null,
        effectiveTimezone: null,
        nextRunAt: null,
        lastRunAt: null,
        success: true,
      }),
    ).toBe("Every 1 hr (8:00–22:00)");
  });

  test("appends the fallback timezone to interval active hours", () => {
    expect(
      heartbeatSubtitle(
        {
          enabled: true,
          intervalMs: 3_600_000,
          activeHoursStart: 8,
          activeHoursEnd: 22,
          cronExpression: null,
          timezone: null,
          effectiveTimezone: null,
          nextRunAt: null,
          lastRunAt: null,
          success: true,
        },
        "America/Los_Angeles",
      ),
    ).toBe("Every 1 hr (8:00–22:00 America/Los_Angeles)");
  });

  test("prefers effectiveTimezone over the stored override and fallback", () => {
    expect(
      heartbeatSubtitle(
        {
          enabled: true,
          intervalMs: 3_600_000,
          activeHoursStart: 8,
          activeHoursEnd: 22,
          cronExpression: null,
          timezone: "America/New_York",
          effectiveTimezone: "America/Chicago",
          nextRunAt: null,
          lastRunAt: null,
          success: true,
        },
        "America/Los_Angeles",
      ),
    ).toBe("Every 1 hr (8:00–22:00 America/Chicago)");
  });
});

describe("schedule formatters localization", () => {
  beforeEach(async () => {
    await initI18n();
    await changeLocale("en");
  });

  test("formats interval in English", () => {
    expect(formatInterval(3_600_000)).toBe("Every 1 hr");
    expect(formatInterval(7_200_000)).toBe("Every 2 hrs");
    expect(formatInterval(1_800_000)).toBe("Every 30 mins");
  });

  test("formats retrospective subtitle in English", () => {
    expect(retrospectiveSubtitle()).toBe("After conversation activity");
  });

  test("formats interval and retrospective subtitle in Simplified Chinese", async () => {
    await changeLocale("zh");
    expect(formatInterval(3_600_000)).toBe("每 1 小时");
    expect(formatInterval(7_200_000)).toBe("每 2 小时");
    expect(formatInterval(1_800_000)).toBe("每 30 分钟");
    expect(retrospectiveSubtitle()).toBe("在对话活动后触发");
  });

  test("formats interval and retrospective subtitle in Traditional Chinese", async () => {
    await changeLocale("zh-TW");
    expect(formatInterval(3_600_000)).toBe("每 1 小時");
    expect(formatInterval(7_200_000)).toBe("每 2 小時");
    expect(formatInterval(1_800_000)).toBe("每 30 分鐘");
    expect(retrospectiveSubtitle()).toBe("在對話活動後觸發");
  });

  test("formats consolidation subtitle in Simplified Chinese", async () => {
    await changeLocale("zh");
    const config = {
      intervalMs: 7_200_000,
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
      available: true,
      success: true,
    };
    expect(consolidationSubtitle(config)).toBe("每 2 小时");
  });

  test("formats heartbeat subtitle with active hours", async () => {
    await changeLocale("zh");
    const config = {
      intervalMs: 3_600_000,
      activeHoursStart: 9,
      activeHoursEnd: 18,
      enabled: true,
      lastRunAt: null,
      nextRunAt: null,
      cronExpression: null,
      timezone: null,
      effectiveTimezone: null,
      success: true,
    };
    expect(heartbeatSubtitle(config)).toBe("每 1 小时 (9:00–18:00)");
  });
});
