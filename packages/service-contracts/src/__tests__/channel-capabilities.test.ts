import { describe, expect, test } from "bun:test";

import { CHANNEL_ADDRESS_SCHEMAS } from "../channel-address.js";
import {
  CHANNEL_ADDRESS_CAPABILITIES,
  accountScopedChannels,
  channelAddressCapabilities,
} from "../channel-capabilities.js";
import { CHANNEL_IDS, type ChannelId } from "../channels.js";

const CHANNELS: readonly ChannelId[] = CHANNEL_IDS;

describe("channel address capabilities", () => {
  test("every canonical channel is annotated", () => {
    expect([...CHANNEL_ADDRESS_CAPABILITIES.keys()].sort()).toEqual(
      [...CHANNELS].sort(),
    );
  });

  test("annotations agree with the address schemas they are read from", () => {
    for (const channel of CHANNELS) {
      const capabilities = channelAddressCapabilities(channel);
      const shape = CHANNEL_ADDRESS_SCHEMAS[channel].shape;

      expect(capabilities.channel).toBe(channel);
      expect(capabilities.accountScoped).toBe("scope" in shape);
      expect(capabilities.identityCoordinates).toEqual(
        Object.keys(shape.coordinates.shape).sort(),
      );
      expect(
        capabilities.requiredScopeCoordinates.every((name) =>
          capabilities.scopeCoordinates.includes(name),
        ),
      ).toBe(true);
      if (!capabilities.accountScoped) {
        expect(capabilities.scopeCoordinates).toEqual([]);
        expect(capabilities.requiredScopeCoordinates).toEqual([]);
      } else {
        expect(capabilities.scopeCoordinates.length).toBeGreaterThan(0);
      }
    }
  });

  test("a scoped channel names its scope coordinates", () => {
    expect(channelAddressCapabilities("slack")).toEqual({
      channel: "slack",
      accountScoped: true,
      scopeCoordinates: ["enterpriseId", "teamId"],
      requiredScopeCoordinates: ["teamId"],
      identityCoordinates: ["userId"],
    });
  });

  test("an unscoped channel annotates as unscoped", () => {
    expect(channelAddressCapabilities("telegram")).toEqual({
      channel: "telegram",
      accountScoped: false,
      scopeCoordinates: [],
      requiredScopeCoordinates: [],
      identityCoordinates: ["userId"],
    });
  });

  test("account-scoped channels are exactly those whose variant has a scope", () => {
    expect([...accountScopedChannels()].sort()).toEqual(
      CHANNELS.filter(
        (channel) => "scope" in CHANNEL_ADDRESS_SCHEMAS[channel].shape,
      )
        .slice()
        .sort(),
    );
  });

  test("coordinate name lists are sorted so annotations are comparable", () => {
    for (const channel of CHANNELS) {
      const { scopeCoordinates, identityCoordinates } =
        channelAddressCapabilities(channel);
      expect(scopeCoordinates).toEqual([...scopeCoordinates].sort());
      expect(identityCoordinates).toEqual([...identityCoordinates].sort());
    }
  });
});
