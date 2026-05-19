import { describe, expect, test } from "bun:test";

import type { AdminUsageFilterState } from "@/components/app/settings/billing-usage/useAdminBillingUsageData.js";
import {
  buildAdminBillingUsageSeriesQuery,
  buildAdminBillingUsageTotalsQuery,
} from "@/components/app/settings/billing-usage/useAdminBillingUsageData.js";

function state(
  sourceFilter: AdminUsageFilterState["sourceFilter"],
  llmDimension: AdminUsageFilterState["llmDimension"] = "model",
): AdminUsageFilterState {
  return {
    dateRange: { from: "2026-04-01", to: "2026-04-30" },
    sourceFilter,
    llmDimension,
  };
}

describe("buildAdminBillingUsageSeriesQuery", () => {
  test("all filter returns org-scoped query with no source or group_by", () => {
    expect(
      buildAdminBillingUsageSeriesQuery("org-123", state("all"), "UTC"),
    ).toEqual({
      organization_id: "org-123",
      from: "2026-04-01",
      to: "2026-04-30",
      tz: "UTC",
    });
  });

  test("llm filter groups by model by default", () => {
    expect(
      buildAdminBillingUsageSeriesQuery("org-123", state("llm"), "UTC"),
    ).toMatchObject({
      organization_id: "org-123",
      usage_source: "runtime_proxy",
      group_by: "model",
    });
  });

  test("llm filter groups by task", () => {
    expect(
      buildAdminBillingUsageSeriesQuery(
        "org-123",
        state("llm", "task"),
        "UTC",
      ),
    ).toMatchObject({
      organization_id: "org-123",
      usage_source: "runtime_proxy",
      group_by: "llm_call_site",
    });
  });

  test("llm filter groups by profile", () => {
    expect(
      buildAdminBillingUsageSeriesQuery(
        "org-123",
        state("llm", "profile"),
        "UTC",
      ),
    ).toMatchObject({
      organization_id: "org-123",
      usage_source: "runtime_proxy",
      group_by: "inference_profile",
    });
  });

  test("oauth filter groups by provider", () => {
    expect(
      buildAdminBillingUsageSeriesQuery(
        "org-123",
        state("oauth", "task"),
        "UTC",
      ),
    ).toMatchObject({
      organization_id: "org-123",
      usage_source: "oauth_proxy",
      group_by: "oauth_provider",
    });
  });

  test("forwards the caller-supplied timezone", () => {
    expect(
      buildAdminBillingUsageSeriesQuery(
        "org-123",
        state("all"),
        "America/New_York",
      ),
    ).toMatchObject({ tz: "America/New_York" });
  });
});

describe("buildAdminBillingUsageTotalsQuery", () => {
  test("all filter omits usage-source", () => {
    expect(
      buildAdminBillingUsageTotalsQuery("org-123", state("all"), "UTC"),
    ).toEqual({
      organization_id: "org-123",
      from: "2026-04-01",
      to: "2026-04-30",
      tz: "UTC",
    });
  });

  test("llm filter includes usage-source", () => {
    expect(
      buildAdminBillingUsageTotalsQuery("org-123", state("llm"), "UTC"),
    ).toMatchObject({
      usage_source: "runtime_proxy",
    });
  });

  test("oauth filter includes usage-source", () => {
    expect(
      buildAdminBillingUsageTotalsQuery("org-123", state("oauth"), "UTC"),
    ).toMatchObject({
      usage_source: "oauth_proxy",
    });
  });

  test("forwards the caller-supplied timezone", () => {
    expect(
      buildAdminBillingUsageTotalsQuery(
        "org-123",
        state("all"),
        "America/New_York",
      ),
    ).toMatchObject({ tz: "America/New_York" });
  });
});
