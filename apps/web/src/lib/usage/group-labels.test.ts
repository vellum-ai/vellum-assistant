import { describe, expect, test } from "bun:test";

import {
  decorateUsageBreakdownGroups,
  resolveUsageGroupLabel,
  type UsageGroupLabelMetadata,
} from "@/lib/usage/group-labels.js";
import type { UsageGroupBreakdown, UsageGroupBy } from "@/lib/usage/types.js";

function usageGroup(
  overrides: Partial<UsageGroupBreakdown> = {},
): UsageGroupBreakdown {
  return {
    group: "assistant-provided label",
    groupId: "group-id",
    totalInputTokens: 10,
    totalOutputTokens: 20,
    totalCacheCreationTokens: 30,
    totalCacheReadTokens: 40,
    totalEstimatedCostUsd: 0.12,
    eventCount: 2,
    ...overrides,
  };
}

describe("resolveUsageGroupLabel", () => {
  test("uses call-site metadata display names keyed by groupKey", () => {
    const group = usageGroup({
      group: "mainAgent",
      groupKey: "mainAgent",
    });

    expect(
      resolveUsageGroupLabel("task", group, {
        callSites: {
          mainAgent: {
            id: "mainAgent",
            displayName: "Main Agent",
            description: "",
            domain: "",
          },
        },
      }),
    ).toBe("Main Agent");
  });

  test("falls back to the assistant-provided call-site group when metadata is missing", () => {
    const group = usageGroup({
      group: "mainAgent",
      groupKey: "mainAgent",
    });

    expect(resolveUsageGroupLabel("task", group, {})).toBe("mainAgent");
    expect(
      resolveUsageGroupLabel("task", usageGroup({ groupKey: null }), {
        callSites: {},
      }),
    ).toBe("assistant-provided label");
  });

  test("uses profile metadata display names keyed by groupKey", () => {
    const group = usageGroup({
      group: "quality-optimized",
      groupKey: "quality-optimized",
    });

    expect(
      resolveUsageGroupLabel("profile", group, {
        profiles: {
          "quality-optimized": {
            id: "quality-optimized",
            displayName: "Quality",
          },
        },
      }),
    ).toBe("Quality");
  });

  test("falls back to the assistant-provided profile group when metadata is missing", () => {
    const group = usageGroup({
      group: "quality-optimized",
      groupKey: "quality-optimized",
    });

    expect(resolveUsageGroupLabel("profile", group, {})).toBe(
      "quality-optimized",
    );
  });

  test("uses profile fallback labels for null and empty profile keys", () => {
    expect(
      resolveUsageGroupLabel(
        "profile",
        usageGroup({ group: "Default", groupKey: null }),
        {},
      ),
    ).toBe("Default");
    expect(
      resolveUsageGroupLabel(
        "profile",
        usageGroup({ group: "", groupKey: "" }),
        {},
      ),
    ).toBe("Default / Unset");
  });

  test.each(["model", "provider", "actor", "conversation"] as UsageGroupBy[])(
    "leaves %s groups unchanged",
    (groupBy) => {
      const group = usageGroup({
        group: `${groupBy} label`,
        groupKey: "metadata-key",
      });
      const metadata: UsageGroupLabelMetadata = {
        callSites: {
          "metadata-key": {
            id: "metadata-key",
            displayName: "Metadata Label",
            description: "",
            domain: "",
          },
        },
        profiles: {
          "metadata-key": {
            id: "metadata-key",
            displayName: "Metadata Label",
          },
        },
      };

      expect(resolveUsageGroupLabel(groupBy, group, metadata)).toBe(
        `${groupBy} label`,
      );
    },
  );
});

describe("decorateUsageBreakdownGroups", () => {
  test("returns new objects only for groups with resolved labels", () => {
    const changed = usageGroup({
      group: "mainAgent",
      groupId: "group-1",
      groupKey: "mainAgent",
    });
    const unchanged = usageGroup({
      group: "missingCallSite",
      groupId: "group-2",
      groupKey: "missingCallSite",
      eventCount: 4,
    });

    const decorated = decorateUsageBreakdownGroups(
      [changed, unchanged],
      "task",
      {
        callSites: {
          mainAgent: {
            id: "mainAgent",
            displayName: "Main Agent",
            description: "",
            domain: "",
          },
        },
      },
    );

    expect(decorated[0]).toEqual({
      ...changed,
      group: "Main Agent",
    });
    expect(decorated[0]).not.toBe(changed);
    expect(decorated[1]).toBe(unchanged);
  });
});
