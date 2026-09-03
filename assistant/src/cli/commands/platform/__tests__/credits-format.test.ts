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
  plan_credit_remaining: 9.1,
  plan_credit_total: 20,
  plan_credit_used_fraction: 0.545,
  plan_credits_spent: false,
  extra_credit_remaining: 33.07,
  credits_expiring_soon: 9.1,
  next_credit_expiry_at: "2026-10-01T00:00:00Z",
};

const NO_GRANTS: PlatformCreditsResult = {
  ...BASE,
  plan_credit_remaining: null,
  plan_credit_total: null,
  plan_credit_used_fraction: null,
  plan_credits_spent: null,
  extra_credit_remaining: null,
  credits_expiring_soon: null,
  next_credit_expiry_at: null,
};

describe("formatCreditsLines", () => {
  test("labels daily spend as counted against the daily limit, never as total spend", () => {
    const lines = formatCreditsLines(NO_GRANTS);

    expect(lines[2]).toBe(
      "Today:     $3.25 counted against the $10.00 daily limit",
    );
    expect(lines.join("\n")).not.toContain("spent");
  });

  test("says when no daily limit is set and flags a reached or skipped limit", () => {
    expect(formatCreditsLines({ ...NO_GRANTS, daily_limit: null })[2]).toBe(
      "Today:     $3.25 counted against the daily limit (none set)",
    );
    expect(
      formatCreditsLines({ ...NO_GRANTS, daily_limit_reached: true })[2],
    ).toEndWith(" (limit reached)");
    expect(
      formatCreditsLines({ ...NO_GRANTS, daily_limit_snoozed: true })[2],
    ).toEndWith(" (limit skipped for today)");
  });

  test("omits the daily line without daily spend and adds the low-balance warning", () => {
    const lines = formatCreditsLines({
      ...NO_GRANTS,
      daily_spend: null,
      low_balance_warning: true,
    });

    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe(
      "Warning:   balance is below the low-balance threshold of $5.00",
    );
  });

  test("reports plan credit left with the meter percentage, extra credit, and expiry", () => {
    const lines = formatCreditsLines(BASE);

    expect(lines[2]).toBe(
      "Plan:      $9.10 of $20.00 plan credit left (55% used)",
    );
    expect(lines[3]).toBe(
      "Extra:     $33.07 bought or earned on top of plan credit",
    );
    expect(lines[4]).toBe(
      "Expiring:  $9.10 within 30 days (next expiry 2026-10-01T00:00:00Z)",
    );
    expect(lines[5]).toStartWith("Today:     $3.25 counted against");
  });

  test("says plan credit is used up and skips the expiry line when nothing is scheduled", () => {
    const spent = {
      ...BASE,
      plan_credit_remaining: 0,
      plan_credit_used_fraction: 1,
      plan_credits_spent: true,
      credits_expiring_soon: 0,
      next_credit_expiry_at: null,
    };
    const lines = formatCreditsLines({
      ...spent,
      extra_credit_remaining: 42.17,
    });

    expect(lines[2]).toBe(
      "Plan:      plan credit used up or expired; managed usage now draws on extra credit",
    );
    expect(lines[3]).toBe(
      "Extra:     $42.17 bought or earned on top of plan credit",
    );
    expect(lines[4]).toStartWith("Today:");

    expect(formatCreditsLines({ ...spent, extra_credit_remaining: 0 })[2]).toBe(
      "Plan:      plan credit used up or expired, and no extra credit remains",
    );
  });

  test("shows the next expiry when it falls beyond the 30-day window", () => {
    const lines = formatCreditsLines({ ...BASE, credits_expiring_soon: 0 });

    expect(lines[4]).toBe(
      "Expiry:    next credit expiry 2026-10-01T00:00:00Z (nothing expires within 30 days)",
    );
  });

  test("formats a negative remaining balance with the sign first", () => {
    expect(formatCreditsLines({ ...BASE, remaining: -2.5 })[0]).toStartWith(
      "Remaining: -$2.50 USD",
    );
  });
});
