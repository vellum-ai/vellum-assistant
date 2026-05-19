import { describe, expect, test } from "bun:test";

import type { UsageChartState } from "@/components/app/settings/billing-usage/useBillingUsageData.js";
import {
  buildBillingUsageSeriesQuery,
  buildBillingUsageTotalsQuery,
} from "@/components/app/settings/billing-usage/useBillingUsageData.js";

function state(
  drilldown: UsageChartState["drilldown"],
): UsageChartState {
  return {
    dateRange: { from: "2026-04-01", to: "2026-04-30" },
    setDateRange: () => {},
    drilldown,
    setDrilldown: () => {},
  };
}

describe("buildBillingUsageSeriesQuery", () => {
  test("keeps top-level usage grouped by usage source", () => {
    expect(buildBillingUsageSeriesQuery(state(null), "UTC")).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
      tz: "UTC",
    });
  });

  test("groups LLM drilldown by model by default", () => {
    expect(
      buildBillingUsageSeriesQuery(state({ usageSource: "runtime_proxy" }), "UTC"),
    ).toMatchObject({
      usage_source: "runtime_proxy",
      group_by: "model",
    });
  });

  test("groups LLM drilldown by task", () => {
    expect(
      buildBillingUsageSeriesQuery(
        state({ usageSource: "runtime_proxy", llmDimension: "task" }),
        "UTC",
      ),
    ).toMatchObject({
      usage_source: "runtime_proxy",
      group_by: "llm_call_site",
    });
  });

  test("groups LLM drilldown by profile", () => {
    expect(
      buildBillingUsageSeriesQuery(
        state({ usageSource: "runtime_proxy", llmDimension: "profile" }),
        "UTC",
      ),
    ).toMatchObject({
      usage_source: "runtime_proxy",
      group_by: "inference_profile",
    });
  });

  test("keeps OAuth drilldown grouped by provider", () => {
    expect(
      buildBillingUsageSeriesQuery(
        state({ usageSource: "oauth_proxy", llmDimension: "task" }),
        "UTC",
      ),
    ).toMatchObject({
      usage_source: "oauth_proxy",
      group_by: "oauth_provider",
    });
  });

  test("forwards the caller-supplied timezone", () => {
    expect(
      buildBillingUsageSeriesQuery(state(null), "America/New_York"),
    ).toMatchObject({ tz: "America/New_York" });
  });
});

describe("buildBillingUsageTotalsQuery", () => {
  test("backing out removes usage-source filters", () => {
    expect(buildBillingUsageTotalsQuery(state(null), "UTC")).toEqual({
      from: "2026-04-01",
      to: "2026-04-30",
      tz: "UTC",
    });
  });

  test("forwards the caller-supplied timezone", () => {
    expect(
      buildBillingUsageTotalsQuery(state(null), "America/New_York"),
    ).toMatchObject({ tz: "America/New_York" });
  });
});
