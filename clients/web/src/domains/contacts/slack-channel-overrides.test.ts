import { describe, expect, test } from "bun:test";

import { THRESHOLD_PRESETS } from "@/utils/threshold-presets";

import {
  CAPABILITY_TIER_META,
  CAPABILITY_TIER_VALUES,
  defaultTierFromCells,
  resolveChannelTier,
  tierOverridesFromCells,
  type ChannelTierCell,
} from "./slack-channel-overrides";

describe("resolveChannelTier", () => {
  test("no cell resolves to an unset tier — the global setting applies, not a hardcoded default", () => {
    expect(resolveChannelTier(undefined)).toEqual({
      tier: null,
      overridden: false,
    });
  });

  test("a persisted cell flags the row as custom", () => {
    expect(resolveChannelTier("low")).toEqual({
      tier: "low",
      overridden: true,
    });
  });

  test("a high cell is still an override — it pins the channel above the global cascade", () => {
    expect(resolveChannelTier("high")).toEqual({
      tier: "high",
      overridden: true,
    });
  });
});

describe("tier ↔ preset parity", () => {
  test("tiers are the global presets' thresholds, in preset order", () => {
    expect(CAPABILITY_TIER_VALUES).toEqual(
      THRESHOLD_PRESETS.map((preset) => preset.riskThreshold),
    );
  });

  test("labels come from the matching global preset — no redefined names", () => {
    for (const preset of THRESHOLD_PRESETS) {
      expect(CAPABILITY_TIER_META[preset.riskThreshold].label).toBe(
        preset.label,
      );
    }
  });
});

describe("CAPABILITY_TIER_META", () => {
  test("tones follow the existing status mapping", () => {
    expect(CAPABILITY_TIER_META.none.tone).toBe("negative");
    expect(CAPABILITY_TIER_META.low.tone).toBe("warning");
    expect(CAPABILITY_TIER_META.medium.tone).toBe("info");
    expect(CAPABILITY_TIER_META.high.tone).toBe("positive");
  });

  test("sublabels use the behavior framing, not tool inventory", () => {
    expect(CAPABILITY_TIER_META.none.sublabel).toBe("ask before every action");
    expect(CAPABILITY_TIER_META.low.sublabel).toBe(
      "safe actions, ask for the rest",
    );
    expect(CAPABILITY_TIER_META.medium.sublabel).toBe("workspace actions too");
    expect(CAPABILITY_TIER_META.high.sublabel).toBe("acts freely");
  });
});

describe("defaultTierFromCells", () => {
  const cell = (
    scope: string,
    threshold: ChannelTierCell["threshold"],
    extra: Partial<ChannelTierCell["selector"]> = {},
    contactType = "trusted_contact",
  ): ChannelTierCell => ({
    selector: { scope, adapter: "slack", ...extra },
    contactType,
    threshold,
  });

  test("no broader-scope cells resolves to null — the global thresholds apply", () => {
    expect(
      defaultTierFromCells(
        [cell("channel", "high", { channelExternalId: "C1" })],
        "slack",
        "public",
      ),
    ).toBeNull();
  });

  test("channel_type cell wins over adapter and workspace cells", () => {
    const cells = [
      cell("workspace", "high", { adapter: undefined }),
      cell("adapter", "medium"),
      cell("channel_type", "low", { channelType: "public" }),
    ];
    expect(defaultTierFromCells(cells, "slack", "public")).toBe("low");
    // The private kind has no channel_type cell → next scope up wins.
    expect(defaultTierFromCells(cells, "slack", "private")).toBe("medium");
  });

  test("other adapters' cells are ignored", () => {
    expect(
      defaultTierFromCells(
        [
          cell("channel_type", "none", {
            adapter: "telegram",
            channelType: "public",
          }),
        ],
        "slack",
        "public",
      ),
    ).toBeNull();
  });

  test("trusted_contact is the representative when cells diverge", () => {
    const cells = [
      cell("channel_type", "none", { channelType: "public" }, "unknown"),
      cell("channel_type", "medium", { channelType: "public" }),
    ];
    expect(defaultTierFromCells(cells, "slack", "public")).toBe("medium");
  });
});

describe("tierOverridesFromCells", () => {
  const cell = (
    overrides: Partial<ChannelTierCell["selector"]> & {
      contactType?: string;
      threshold?: ChannelTierCell["threshold"];
    },
  ): ChannelTierCell => ({
    selector: {
      scope: overrides.scope ?? "channel",
      adapter: overrides.adapter ?? "slack",
      channelExternalId: overrides.channelExternalId,
    },
    contactType: overrides.contactType ?? "trusted_contact",
    threshold: overrides.threshold ?? "low",
  });

  test("maps channel-scope cells for the adapter to their thresholds", () => {
    const overrides = tierOverridesFromCells(
      [
        cell({ channelExternalId: "C1", threshold: "low" }),
        cell({ channelExternalId: "C2", threshold: "medium" }),
      ],
      "slack",
    );
    expect(overrides).toEqual({ C1: "low", C2: "medium" });
  });

  test("ignores other scopes and other adapters", () => {
    const overrides = tierOverridesFromCells(
      [
        cell({ scope: "adapter" }),
        cell({ scope: "channel_type" }),
        cell({ channelExternalId: "C1", adapter: "telegram" }),
      ],
      "slack",
    );
    expect(overrides).toEqual({});
  });

  test("trusted_contact is the representative when cells diverge", () => {
    const overrides = tierOverridesFromCells(
      [
        cell({
          channelExternalId: "C1",
          contactType: "unknown",
          threshold: "none",
        }),
        cell({
          channelExternalId: "C1",
          contactType: "trusted_contact",
          threshold: "high",
        }),
      ],
      "slack",
    );
    expect(overrides).toEqual({ C1: "high" });
  });
});
