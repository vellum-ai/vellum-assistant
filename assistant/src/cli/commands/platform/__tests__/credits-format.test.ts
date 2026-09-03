import { describe, expect, test } from "bun:test";

import {
  formatCreditsLines,
  type PlatformCreditsResult,
} from "../credits-format.js";

const BASE: PlatformCreditsResult = {
  remaining: 42.17,
  settled: 50,
  pending: 7.83,
  unit: "USD",
  stale: false,
  as_of: "2026-07-06T00:00:00.000Z",
  daily_spend: 3.25,
  daily_limit: 10,
  daily_limit_reached: false,
  daily_limit_snoozed: false,
  low_balance_threshold: 5,
  low_balance_warning: false,
};

describe("formatCreditsLines", () => {
  test("labels daily spend as counted against the daily limit, never as total spend", () => {
    const lines = formatCreditsLines(BASE);

    expect(lines[2]).toBe(
      "Today:     $3.25 counted against the $10.00 daily limit",
    );
    expect(lines.join("\n")).not.toContain("spent");
  });

  test("says when no daily limit is set and flags a reached or skipped limit", () => {
    expect(formatCreditsLines({ ...BASE, daily_limit: null })[2]).toBe(
      "Today:     $3.25 counted against the daily limit (none set)",
    );
    expect(
      formatCreditsLines({ ...BASE, daily_limit_reached: true })[2],
    ).toEndWith(" (limit reached)");
    expect(
      formatCreditsLines({ ...BASE, daily_limit_snoozed: true })[2],
    ).toEndWith(" (limit skipped for today)");
  });

  test("omits the daily line without daily spend and adds the low-balance warning", () => {
    const lines = formatCreditsLines({
      ...BASE,
      daily_spend: null,
      low_balance_warning: true,
    });

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      "Warning:   balance is below the low-balance threshold of $5.00",
    );
  });

  test("formats a negative remaining balance with the sign first", () => {
    expect(formatCreditsLines({ ...BASE, remaining: -2.5 })[0]).toStartWith(
      "Remaining: -$2.50 USD",
    );
  });
});
