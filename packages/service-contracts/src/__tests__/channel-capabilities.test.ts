import { describe, expect, test } from "bun:test";

import { CHANNEL_ADDRESS_SCHEMAS } from "../channel-address.js";
import {
  CHANNEL_ADDRESS_CAPABILITIES,
  accountScopedChannels,
  channelAddressCapabilities,
  threadableChannels,
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
      expect(capabilities.conversationCoordinates).toEqual(
        Object.keys(shape.coordinates.shape).sort(),
      );
      expect(
        capabilities.requiredConversationCoordinates.every((name) =>
          capabilities.conversationCoordinates.includes(name),
        ),
      ).toBe(true);
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

  test("threadable is derived, never asserted", () => {
    for (const channel of CHANNELS) {
      const capabilities = channelAddressCapabilities(channel);
      const hasOptionalCoordinate =
        capabilities.requiredConversationCoordinates.length <
        capabilities.conversationCoordinates.length;
      expect(capabilities.threadable).toBe(hasOptionalCoordinate);
    }
  });

  test("a threaded, scoped channel annotates both", () => {
    expect(channelAddressCapabilities("slack")).toEqual({
      channel: "slack",
      accountScoped: true,
      scopeCoordinates: ["enterpriseId", "teamId"],
      requiredScopeCoordinates: ["teamId"],
      conversationCoordinates: ["conversationId", "threadTs"],
      requiredConversationCoordinates: ["conversationId"],
      threadable: true,
    });
  });

  test("an unscoped, unthreaded channel annotates as neither", () => {
    expect(channelAddressCapabilities("a2a")).toEqual({
      channel: "a2a",
      accountScoped: false,
      scopeCoordinates: [],
      requiredScopeCoordinates: [],
      conversationCoordinates: ["peerAssistantId"],
      requiredConversationCoordinates: ["peerAssistantId"],
      threadable: false,
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

  test("the threadable channels are the ones with a thread coordinate", () => {
    const expected: ChannelId[] = ["discord", "slack", "telegram"];
    expect([...threadableChannels()].sort()).toEqual(expected.sort());
  });

  test("coordinate name lists are sorted so annotations are comparable", () => {
    for (const channel of CHANNELS) {
      const { scopeCoordinates, conversationCoordinates } =
        channelAddressCapabilities(channel);
      expect(scopeCoordinates).toEqual([...scopeCoordinates].sort());
      expect(conversationCoordinates).toEqual(
        [...conversationCoordinates].sort(),
      );
    }
  });
});
