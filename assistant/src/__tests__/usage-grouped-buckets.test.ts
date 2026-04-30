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

  test("uses stable sentinel keys for null grouped series values", () => {
    expect(stableUsageSeriesGroupKey("call_site", null)).toBe(
      "__unknown_task__",
    );
    expect(stableUsageSeriesGroupKey("inference_profile", null)).toBe(
      "__default_unset__",
    );
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
    expect(buckets[0].groups.mainAgent.group).toBe("Main agent");
    expect(buckets[0].groups.__unknown_task__).toMatchObject({
      group: "Unknown Task",
      groupKey: null,
      totalInputTokens: 200,
    });
  });
});
