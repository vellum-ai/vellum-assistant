import { describe, expect, test } from "bun:test";

import {
  CAPABILITY_TIER_META,
  CAPABILITY_TIER_THRESHOLDS,
  resolveChannelTier,
  tierFromThreshold,
  tierOverridesFromCells,
  type ChannelTierCell,
} from "./slack-channel-overrides";

describe("resolveChannelTier", () => {
  test("no override resolves the room default with no divergence", () => {
    expect(resolveChannelTier(undefined)).toEqual({
      tier: "full_access",
      overridden: false,
    });
  });

  test("a diverging override flags the row as custom", () => {
    expect(resolveChannelTier("standard")).toEqual({
      tier: "standard",
      overridden: true,
    });
  });

  test("a persisted cell matching the default is not flagged", () => {
    expect(resolveChannelTier("full_access")).toEqual({
      tier: "full_access",
      overridden: false,
    });
  });
});

describe("tier ↔ threshold mapping", () => {
  test("write mapping covers every tier", () => {
    expect(CAPABILITY_TIER_THRESHOLDS).toEqual({
      strict: "none",
      standard: "low",
      full_access: "high",
    });
  });

  test("read mapping inverts writes and folds medium into standard", () => {
    expect(tierFromThreshold("none")).toBe("strict");
    expect(tierFromThreshold("low")).toBe("standard");
    expect(tierFromThreshold("medium")).toBe("standard");
    expect(tierFromThreshold("high")).toBe("full_access");
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

  test("maps channel-scope cells for the adapter to tiers", () => {
    const overrides = tierOverridesFromCells(
      [cell({ channelExternalId: "C1", threshold: "low" })],
      "slack",
    );
    expect(overrides).toEqual({ C1: "standard" });
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
    expect(overrides).toEqual({ C1: "full_access" });
  });
});

describe("CAPABILITY_TIER_META", () => {
  test("strict and full access reuse the threshold-preset labels", () => {
    expect(CAPABILITY_TIER_META.strict.label).toBe("Strict");
    expect(CAPABILITY_TIER_META.full_access.label).toBe("Full access");
    expect(CAPABILITY_TIER_META.standard.label).toBe("Standard");
  });

  test("tones follow the existing status mapping", () => {
    expect(CAPABILITY_TIER_META.strict.tone).toBe("negative");
    expect(CAPABILITY_TIER_META.standard.tone).toBe("warning");
    expect(CAPABILITY_TIER_META.full_access.tone).toBe("positive");
  });
});
