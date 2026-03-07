/**
 * Regression tests for the channel policy registry.
 *
 * Validates that every ChannelId has a policy entry, that helper functions
 * return correct values, and that the compile-time exhaustiveness constraint
 * is backed by runtime assertions.
 */

import { describe, expect, test } from "bun:test";

import {
  type ConversationStrategy,
  getChannelPolicy,
  getConversationStrategy,
  getDeliverableChannels,
  isNotificationDeliverable,
} from "../channels/config.js";
import { CHANNEL_IDS, type ChannelId } from "../channels/types.js";

describe("channel policy registry", () => {
  // ── Exhaustiveness ────────────────────────────────────────────────────

  test("every ChannelId has a policy entry", () => {
    for (const channelId of CHANNEL_IDS) {
      const policy = getChannelPolicy(channelId);
      expect(policy).toBeDefined();
      expect(policy.notification).toBeDefined();
      expect(typeof policy.notification.deliveryEnabled).toBe("boolean");
      expect(typeof policy.notification.conversationStrategy).toBe("string");
    }
  });

  test("CHANNEL_IDS contains at least one channel", () => {
    expect(CHANNEL_IDS.length).toBeGreaterThan(0);
  });

  // ── getDeliverableChannels ────────────────────────────────────────────

  test("getDeliverableChannels returns exactly the channels with deliveryEnabled: true", () => {
    const deliverable = getDeliverableChannels();
    const expected = CHANNEL_IDS.filter(
      (id) => getChannelPolicy(id).notification.deliveryEnabled,
    );

    expect(deliverable).toHaveLength(expected.length);
    for (const id of expected) {
      expect(deliverable).toContain(id);
    }
  });

  test("getDeliverableChannels returns a non-empty array", () => {
    // At minimum, vellum should always be deliverable.
    const deliverable = getDeliverableChannels();
    expect(deliverable.length).toBeGreaterThan(0);
    expect(deliverable).toContain("vellum");
  });

  test("getDeliverableChannels does not include channels with deliveryEnabled: false", () => {
    const deliverable = getDeliverableChannels();
    for (const id of CHANNEL_IDS) {
      if (!getChannelPolicy(id).notification.deliveryEnabled) {
        expect(deliverable).not.toContain(id);
      }
    }
  });

  // ── getChannelPolicy ─────────────────────────────────────────────────

  test("getChannelPolicy returns valid policy for every ChannelId", () => {
    const validStrategies = new Set([
      "start_new_conversation",
      "continue_existing_conversation",
      "not_deliverable",
    ]);

    for (const channelId of CHANNEL_IDS) {
      const policy = getChannelPolicy(channelId);
      expect(
        validStrategies.has(policy.notification.conversationStrategy),
      ).toBe(true);
    }
  });

  // ── isNotificationDeliverable ─────────────────────────────────────────

  test("isNotificationDeliverable reflects deliveryEnabled for every ChannelId", () => {
    for (const channelId of CHANNEL_IDS) {
      const policy = getChannelPolicy(channelId);
      expect(isNotificationDeliverable(channelId)).toBe(
        policy.notification.deliveryEnabled,
      );
    }
  });

  // ── getConversationStrategy ───────────────────────────────────────────

  test("getConversationStrategy returns correct strategies per channel", () => {
    // Known assertions for current policy (regression guard)
    const expectedStrategies: [ChannelId, ConversationStrategy][] = [
      ["vellum", "start_new_conversation"],
      ["telegram", "continue_existing_conversation"],
      ["voice", "continue_existing_conversation"],
      ["voice", "not_deliverable"],
    ];

    for (const [channelId, expected] of expectedStrategies) {
      expect(getConversationStrategy(channelId)).toBe(expected);
    }
  });

  test("getConversationStrategy returns a valid strategy for every ChannelId", () => {
    const validStrategies = new Set([
      "start_new_conversation",
      "continue_existing_conversation",
      "not_deliverable",
    ]);

    for (const channelId of CHANNEL_IDS) {
      const strategy = getConversationStrategy(channelId);
      expect(validStrategies.has(strategy)).toBe(true);
    }
  });

  // ── SMS channel policy ───────────────────────────────────────────────

  test("SMS is a deliverable notification channel", () => {
    expect(isNotificationDeliverable("voice")).toBe(true);
    expect(getDeliverableChannels()).toContain("voice");
  });

  test("SMS uses continue_existing_conversation strategy", () => {
    expect(getConversationStrategy("voice")).toBe(
      "continue_existing_conversation",
    );
  });

  test("all_channels includes SMS when SMS is deliverable", () => {
    const deliverable = getDeliverableChannels();
    expect(deliverable).toContain("vellum");
    expect(deliverable).toContain("telegram");
    expect(deliverable).toContain("voice");
  });

  // ── Consistency checks ────────────────────────────────────────────────

  test("channels with not_deliverable strategy have deliveryEnabled: false", () => {
    for (const channelId of CHANNEL_IDS) {
      const policy = getChannelPolicy(channelId);
      if (policy.notification.conversationStrategy === "not_deliverable") {
        expect(policy.notification.deliveryEnabled).toBe(false);
      }
    }
  });
});
