import { describe, expect, test } from "bun:test";

import { buildBreakdownQuery, buildSeriesQuery } from "@/lib/usage/api.js";
import type { UsageGroupBy, UsageSeriesGroupBy } from "@/lib/usage/types.js";

describe("buildBreakdownQuery", () => {
  test.each([
    ["task", "call_site"],
    ["profile", "inference_profile"],
    ["model", "model"],
    ["actor", "actor"],
    ["conversation", "conversation"],
  ] as Array<[UsageGroupBy, string]>)(
    "maps %s to daemon groupBy %s",
    (groupBy, wireGroupBy) => {
      expect(
        buildBreakdownQuery({
          from: 100,
          to: 200,
          groupBy,
        }),
      ).toEqual({
        from: "100",
        to: "200",
        groupBy: wireGroupBy,
      });
    },
  );
});

describe("buildSeriesQuery", () => {
  test.each([
    ["task", "call_site"],
    ["profile", "inference_profile"],
    ["model", "model"],
    ["provider", "provider"],
    ["actor", "actor"],
  ] as Array<[UsageSeriesGroupBy, string]>)(
    "maps %s to daemon groupBy %s",
    (groupBy, wireGroupBy) => {
      expect(
        buildSeriesQuery({
          from: 100,
          to: 200,
          granularity: "daily",
          groupBy,
        }),
      ).toEqual({
        from: "100",
        to: "200",
        granularity: "daily",
        groupBy: wireGroupBy,
      });
    },
  );

  test("serializes granularity and timezone", () => {
    expect(
      buildSeriesQuery({
        from: 100,
        to: 200,
        granularity: "hourly",
        groupBy: "model",
        tz: "America/Denver",
      }),
    ).toEqual({
      from: "100",
      to: "200",
      granularity: "hourly",
      groupBy: "model",
      tz: "America/Denver",
    });
  });
});
