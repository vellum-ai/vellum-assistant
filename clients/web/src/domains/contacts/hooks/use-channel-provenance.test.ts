import { describe, expect, it } from "bun:test";

import type { ChannelPolicyView } from "@/lib/channel-admission-policy/types";

import { deriveChannelProvenance } from "./use-channel-provenance";

function policy(
  channelType: string,
  policyValue: ChannelPolicyView["policy"],
  updatedAt: number | null,
): ChannelPolicyView {
  return { channelType, policy: policyValue, note: null, updatedAt };
}

describe("deriveChannelProvenance", () => {
  it("treats a gateway-seeded default row (non-null updatedAt) as the global default", () => {
    const map = deriveChannelProvenance([
      policy("slack", "trusted_contacts", 1_776_000_000_000),
    ]);
    expect(map.slack).toEqual({ source: "global-default" });
  });

  it("treats a floor differing from the global default as channel-set", () => {
    const map = deriveChannelProvenance([
      policy("slack", "guardian_only", 1_776_000_000_000),
      policy("telegram", "strangers", null),
    ]);
    expect(map.slack).toEqual({ source: "channel-default", channel: "slack" });
    expect(map.telegram).toEqual({
      source: "channel-default",
      channel: "telegram",
    });
  });

  it("treats a merged-in default view (null updatedAt) as the global default", () => {
    const map = deriveChannelProvenance([
      policy("phone", "trusted_contacts", null),
    ]);
    expect(map.phone).toEqual({ source: "global-default" });
  });

  it("skips channels without a setup flow", () => {
    const map = deriveChannelProvenance([
      policy("email", "guardian_only", null),
    ]);
    expect(Object.keys(map)).toEqual([]);
  });
});
