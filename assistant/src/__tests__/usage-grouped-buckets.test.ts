import { describe, expect, test } from "bun:test";

import {
  bucketGroupedUsageEvents,
  displayUsageGroup,
  stableUsageSeriesGroupKey,
} from "../memory/usage-grouped-buckets.js";

describe("usage grouped buckets", () => {
  test("uses canonical labels for call-site groups and fallbacks", () => {
    expect(displayUsageGroup("call_site", "mainAgent")).toBe("Main agent");
    expect(displayUsageGroup("call_site", null)).toBe("Unknown Task");
    expect(displayUsageGroup("inference_profile", null)).toBe(
      "Default / Unset",
    );
  });

  test("uses stable collision-proof keys for grouped series values", () => {
    expect(stableUsageSeriesGroupKey("call_site", "mainAgent")).toBe(
      "value:mainAgent",
    );
    expect(stableUsageSeriesGroupKey("call_site", null)).toBe(
      "null:call_site",
    );
    expect(stableUsageSeriesGroupKey("inference_profile", null)).toBe(
      "null:inference_profile",
    );
    expect(
      stableUsageSeriesGroupKey("inference_profile", "null:inference_profile"),
    ).toBe("value:null:inference_profile");
  });

  test("does not double-count bucket totals when empty buckets are disabled", () => {
    const buckets = bucketGroupedUsageEvents(
      [
        {
          created_at: Date.UTC(2026, 3, 10, 10),
          input_tokens: 100,
          output_tokens: 10,
          estimated_cost_usd: 0.01,
          llm_call_count: 1,
          group_key: "mainAgent",
        },
        {
          created_at: Date.UTC(2026, 3, 10, 11),
          input_tokens: 200,
          output_tokens: 20,
          estimated_cost_usd: 0.02,
          llm_call_count: 1,
          group_key: "conversationTitle",
        },
      ],
      {
        from: Date.UTC(2026, 3, 10, 0),
        to: Date.UTC(2026, 3, 10, 23),
      },
      "UTC",
      { granularity: "daily", groupBy: "call_site", fillEmpty: false },
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0].totalInputTokens).toBe(300);
    expect(buckets[0].totalOutputTokens).toBe(30);
    expect(buckets[0].totalEstimatedCostUsd).toBe(0.03);
    expect(buckets[0].eventCount).toBe(2);
    expect(buckets[0].groups["value:mainAgent"].totalInputTokens).toBe(100);
    expect(
      buckets[0].groups["value:conversationTitle"].totalInputTokens,
    ).toBe(200);
  });

  test("keeps unset inference profiles separate from matching profile names", () => {
    const buckets = bucketGroupedUsageEvents(
      [
        {
          created_at: Date.UTC(2026, 3, 10, 10),
          input_tokens: 100,
          output_tokens: 10,
          estimated_cost_usd: 0.01,
          llm_call_count: 1,
          group_key: null,
        },
        {
          created_at: Date.UTC(2026, 3, 10, 11),
          input_tokens: 200,
          output_tokens: 20,
          estimated_cost_usd: 0.02,
          llm_call_count: 1,
          group_key: "null:inference_profile",
        },
      ],
      {
        from: Date.UTC(2026, 3, 10, 0),
        to: Date.UTC(2026, 3, 10, 23),
      },
      "UTC",
      {
        granularity: "daily",
        groupBy: "inference_profile",
        fillEmpty: true,
      },
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0].groups["null:inference_profile"]).toMatchObject({
      group: "Default / Unset",
      groupKey: null,
      totalInputTokens: 100,
    });
    expect(buckets[0].groups["value:null:inference_profile"]).toMatchObject({
      group: "null:inference_profile",
      groupKey: "null:inference_profile",
      totalInputTokens: 200,
    });
  });

  test("buckets grouped events without dropping null call-site rows", () => {
    const buckets = bucketGroupedUsageEvents(
      [
        {
          created_at: Date.UTC(2026, 3, 10, 10),
          input_tokens: 100,
          output_tokens: 10,
          estimated_cost_usd: 0.01,
          llm_call_count: 1,
          group_key: "mainAgent",
        },
        {
          created_at: Date.UTC(2026, 3, 10, 11),
          input_tokens: 200,
          output_tokens: 20,
          estimated_cost_usd: 0.02,
          llm_call_count: 1,
          group_key: null,
        },
      ],
      {
        from: Date.UTC(2026, 3, 10, 0),
        to: Date.UTC(2026, 3, 10, 23),
      },
      "UTC",
      { granularity: "daily", groupBy: "call_site", fillEmpty: true },
    );

    expect(buckets).toHaveLength(1);
    expect(buckets[0].totalInputTokens).toBe(300);
    expect(buckets[0].groups["value:mainAgent"].group).toBe("Main agent");
    expect(buckets[0].groups["null:call_site"]).toMatchObject({
      group: "Unknown Task",
      groupKey: null,
      totalInputTokens: 200,
    });
  });
});
