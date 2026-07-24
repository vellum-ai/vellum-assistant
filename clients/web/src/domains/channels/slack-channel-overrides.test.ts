import { describe, expect, test } from "bun:test";

import { THRESHOLD_PRESETS } from "@/utils/threshold-presets";

import {
  bucketDefaultFromCells,
  CAPABILITY_TIER_META,
  CAPABILITY_TIER_VALUES,
  tierOverridesFromCells,
  type ChannelTierCell,
} from "./slack-channel-overrides";

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

  test("sublabels frame each tier's read/answer depth, not free action", () => {
    expect(CAPABILITY_TIER_META.none.sublabel).toBe("asks before acting");
    expect(CAPABILITY_TIER_META.low.sublabel).toBe("safe reads only");
    expect(CAPABILITY_TIER_META.medium.sublabel).toBe("broader lookups");
    expect(CAPABILITY_TIER_META.high.sublabel).toBe("answers on its own");
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

describe("bucketDefaultFromCells", () => {
  const adapterCell = (
    adapter: string,
    threshold: ChannelTierCell["threshold"],
    contactType = "trusted_contact",
  ): ChannelTierCell => ({
    selector: { scope: "adapter", adapter },
    contactType,
    threshold,
  });

  const dmCell = (
    adapter: string,
    threshold: ChannelTierCell["threshold"],
    contactType = "trusted_contact",
  ): ChannelTierCell => ({
    selector: { scope: "channel_type", adapter, channelType: "dm" },
    contactType,
    threshold,
  });

  test("reads the adapter-scope cell as the 'channels' default", () => {
    const cells = [adapterCell("slack", "medium")];
    expect(bucketDefaultFromCells(cells, "slack", "channels")).toBe("medium");
    expect(bucketDefaultFromCells(cells, "slack", "dm")).toBeUndefined();
  });

  test("reads the channel_type:dm cell as the 'dm' default", () => {
    const cells = [dmCell("slack", "none")];
    expect(bucketDefaultFromCells(cells, "slack", "dm")).toBe("none");
    expect(bucketDefaultFromCells(cells, "slack", "channels")).toBeUndefined();
  });

  test("ignores other adapters and non-dm channel types", () => {
    const cells: ChannelTierCell[] = [
      adapterCell("telegram", "high"),
      {
        selector: { scope: "channel_type", adapter: "slack", channelType: "private" },
        contactType: "trusted_contact",
        threshold: "high",
      },
    ];
    expect(bucketDefaultFromCells(cells, "slack", "channels")).toBeUndefined();
    expect(bucketDefaultFromCells(cells, "slack", "dm")).toBeUndefined();
  });

  test("trusted_contact is representative when contact types diverge", () => {
    const cells = [
      adapterCell("slack", "none", "unknown"),
      adapterCell("slack", "medium", "trusted_contact"),
    ];
    expect(bucketDefaultFromCells(cells, "slack", "channels")).toBe("medium");
  });
});
