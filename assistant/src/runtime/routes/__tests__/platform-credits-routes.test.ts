/**
 * Unit tests for the platform_credits route handler: field mapping from the
 * platform billing summary, including the daily-limit and low-balance state,
 * and the fallbacks when a summary omits those fields.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { UnprocessableEntityError } from "../errors.js";

let platformBaseUrl = "https://platform.test";
let authHeader: string | null = "Api-Key test";

// Spread the real module: replacing it wholesale breaks unrelated importers
// pulled in by the module under test.
const actualRegistration =
  await import("../../../inbound/platform-callback-registration.js");
mock.module("../../../inbound/platform-callback-registration.js", () => ({
  ...actualRegistration,
  resolvePlatformCallbackRegistrationContext: async () => ({
    isPlatform: false,
    platformBaseUrl,
    assistantId: "assistant-123",
    hasAssistantApiKey: !!authHeader,
    authHeader,
    enabled: !!(platformBaseUrl && authHeader),
  }),
}));

const { ROUTES } = await import("../platform-routes.js");

const creditsHandler = ROUTES.find(
  (r) => r.operationId === "platform_credits",
)!.handler;

const SUMMARY_URL = "https://platform.test/v1/organizations/billing/summary/";
const SUBSCRIPTION_URL =
  "https://platform.test/v1/organizations/billing/subscription/";

const FULL_SUMMARY = {
  settled_balance_usd: "50.00",
  pending_compute_usd: "7.83",
  effective_balance_usd: "42.17",
  is_degraded: false,
  daily_credit_limit_usd: "10.00",
  daily_spend_usd: "3.25",
  daily_limit_reached: false,
  daily_limit_snoozed: true,
  low_balance_threshold_usd: "5.00",
  low_balance_warning: true,
  available_usage_balance: "9.10",
  total_usage_balance: "20.00",
  credits_expiring_soon_usd: "9.10",
  next_credit_expiry_at: "2026-10-01T00:00:00Z",
};

const realFetch = globalThis.fetch;
let fetchedUrls: string[] = [];

/**
 * Stub globalThis.fetch: the summary URL answers with `summary`, the
 * subscription URL with `subscription` (a plan, or a 500 when "error").
 */
function stubFetch(
  summary: unknown,
  subscription: { plan_id: "base" | "pro" } | "error" = { plan_id: "pro" },
): void {
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    fetchedUrls.push(url);
    const isSubscription = url === SUBSCRIPTION_URL;
    const status = isSubscription && subscription === "error" ? 500 : 200;
    const body = isSubscription ? subscription : summary;
    return new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
}

beforeEach(() => {
  platformBaseUrl = "https://platform.test";
  authHeader = "Api-Key test";
  fetchedUrls = [];
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

describe("platform_credits", () => {
  test("maps balance, daily-limit, and low-balance fields from the billing summary", async () => {
    stubFetch(FULL_SUMMARY);

    const result = await creditsHandler({});

    expect(fetchedUrls).toEqual([SUMMARY_URL]);
    expect(result).toMatchObject({
      remaining: 42.17,
      settled: 50,
      pending: 7.83,
      unit: "USD",
      stale: false,
      daily_spend: 3.25,
      daily_limit: 10,
      daily_limit_reached: false,
      daily_limit_snoozed: true,
      low_balance_threshold: 5,
      low_balance_warning: true,
      plan_credit_remaining: 9.1,
      plan_credit_total: 20,
      plan_credit_used_fraction: 0.545,
      plan_credits_spent: false,
      extra_credit_remaining: 33.07,
      credits_expiring_soon: 9.1,
      next_credit_expiry_at: "2026-10-01T00:00:00Z",
    });
  });

  test("marks plan credit spent once the grants are used up", async () => {
    stubFetch({ ...FULL_SUMMARY, available_usage_balance: "0.00" });

    expect(await creditsHandler({})).toMatchObject({
      plan_credit_used_fraction: 1,
      plan_credits_spent: true,
      extra_credit_remaining: 42.17,
    });
  });

  test("treats a Pro plan whose grants total nothing as fully spent", async () => {
    stubFetch(
      {
        ...FULL_SUMMARY,
        available_usage_balance: "0.00",
        total_usage_balance: "0.00",
      },
      { plan_id: "pro" },
    );

    expect(await creditsHandler({})).toMatchObject({
      plan_credit_total: 0,
      plan_credit_used_fraction: 1,
      plan_credits_spent: true,
      extra_credit_remaining: 42.17,
    });
    expect(fetchedUrls).toEqual([SUMMARY_URL, SUBSCRIPTION_URL]);
  });

  test("gives a base plan with no grants no reading, and clamps a refund overshoot", async () => {
    stubFetch(
      {
        ...FULL_SUMMARY,
        available_usage_balance: "0.00",
        total_usage_balance: "0.00",
      },
      { plan_id: "base" },
    );
    expect(await creditsHandler({})).toMatchObject({
      plan_credit_used_fraction: null,
      plan_credits_spent: null,
    });

    stubFetch({ ...FULL_SUMMARY, available_usage_balance: "25.00" });
    expect(await creditsHandler({})).toMatchObject({
      plan_credit_used_fraction: 0,
      plan_credits_spent: false,
      extra_credit_remaining: 17.17,
    });
  });

  test("still reads the ratio when the subscription fetch fails, but not the zero-grant case", async () => {
    stubFetch(FULL_SUMMARY, "error");
    expect(await creditsHandler({})).toMatchObject({
      plan_credit_used_fraction: 0.545,
      plan_credits_spent: false,
    });

    stubFetch({ ...FULL_SUMMARY, total_usage_balance: "0.00" }, "error");
    expect(await creditsHandler({})).toMatchObject({
      plan_credit_used_fraction: null,
      plan_credits_spent: null,
    });
  });

  test("reports null and false for daily-limit fields a summary omits", async () => {
    stubFetch({
      settled_balance_usd: "50.00",
      pending_compute_usd: "0.00",
      effective_balance_usd: "50.00",
      is_degraded: true,
    });

    expect(await creditsHandler({})).toMatchObject({
      stale: true,
      daily_spend: null,
      daily_limit: null,
      daily_limit_reached: false,
      daily_limit_snoozed: false,
      low_balance_threshold: null,
      low_balance_warning: false,
      plan_credit_remaining: null,
      plan_credit_total: null,
      plan_credit_used_fraction: null,
      plan_credits_spent: null,
      extra_credit_remaining: null,
      credits_expiring_soon: null,
      next_credit_expiry_at: null,
    });
  });

  test("reports null for a null daily limit and an empty amount", async () => {
    stubFetch({
      ...FULL_SUMMARY,
      daily_credit_limit_usd: null,
      low_balance_threshold_usd: "",
    });

    expect(await creditsHandler({})).toMatchObject({
      daily_spend: 3.25,
      daily_limit: null,
      low_balance_threshold: null,
    });
  });

  test("rejects with UnprocessableEntityError when credentials are missing", async () => {
    authHeader = null;
    stubFetch(FULL_SUMMARY);

    await expect(creditsHandler({})).rejects.toBeInstanceOf(
      UnprocessableEntityError,
    );
    expect(fetchedUrls).toHaveLength(0);
  });
});
