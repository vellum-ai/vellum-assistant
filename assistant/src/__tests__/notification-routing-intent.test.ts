/**
 * Tests for fire-time routing intent enforcement.
 *
 * Validates that the post-decision enforcement step correctly overrides
 * the decision engine's channel selection based on the routing intent
 * persisted on the reminder at create time.
 */

import { describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  isDebug: () => false,
  truncateForLog: (v: string) => v,
}));

import { enforceRoutingIntent } from "../notifications/decision-engine.js";
import type {
  NotificationChannel,
  NotificationDecision,
} from "../notifications/types.js";

// -- Helpers -----------------------------------------------------------------

function makeDecision(
  overrides?: Partial<NotificationDecision>,
): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: ["vellum"],
    reasoningSummary: "LLM selected vellum only",
    renderedCopy: {
      vellum: { title: "Reminder", body: "Test reminder" },
    },
    dedupeKey: "routing-test-001",
    confidence: 0.9,
    fallbackUsed: false,
    ...overrides,
  };
}

// -- Tests -------------------------------------------------------------------

describe("routing intent enforcement", () => {
  describe("all_channels intent", () => {
    test("forces selection to all connected channels", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      expect(enforced.reasoningSummary).toContain(
        "routing_intent=all_channels",
      );
    });

    test("selects all channels even when LLM picked none", () => {
      const decision = makeDecision({ selectedChannels: [] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      // shouldNotify must be true for enforcement to apply
      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );
      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
    });

    test("does not modify decision when shouldNotify is false", () => {
      const decision = makeDecision({
        shouldNotify: false,
        selectedChannels: [],
      });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      expect(enforced.shouldNotify).toBe(false);
      expect(enforced.selectedChannels).toEqual([]);
    });

    test("single connected channel selects that channel", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );
      expect(enforced.selectedChannels).toEqual(["vellum"]);
    });

    test("includes all connected channels in all_channels mode", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram", "slack"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      expect(enforced.selectedChannels).toEqual([
        "vellum",
        "telegram",
        "slack",
      ]);
      expect(enforced.reasoningSummary).toContain(
        "routing_intent=all_channels",
      );
    });

    test("excludes disconnected channels from all_channels", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      expect(enforced.selectedChannels).not.toContain("slack");
    });
  });

  describe("multi_channel intent", () => {
    test("expands to at least two channels when LLM picked fewer than 2 and 2+ are connected", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      expect(enforced.reasoningSummary).toContain(
        "routing_intent=multi_channel",
      );
    });

    test("does not expand to all channels when 3+ are connected", () => {
      const decision = makeDecision({ selectedChannels: ["telegram"] });
      const connected: NotificationChannel[] = [
        "vellum",
        "telegram",
        "telegram",
      ];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["telegram", "vellum"]);
      expect(enforced.selectedChannels).not.toContain("telegram");
    });

    test("does not override when LLM already picked 2+ channels", () => {
      const decision = makeDecision({
        selectedChannels: ["vellum", "telegram"],
      });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      // No enforcement annotation since decision already satisfied the intent
      expect(enforced.reasoningSummary).not.toContain(
        "routing_intent=multi_channel",
      );
    });

    test("does not expand when only 1 channel is connected", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum"];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      // Cannot expand to 2+ when only 1 is available
      expect(enforced.selectedChannels).toEqual(["vellum"]);
    });

    test("does not modify decision when shouldNotify is false", () => {
      const decision = makeDecision({
        shouldNotify: false,
        selectedChannels: [],
      });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "multi_channel",
        connected,
      );

      expect(enforced.shouldNotify).toBe(false);
      expect(enforced.selectedChannels).toEqual([]);
    });
  });

  describe("single_channel intent", () => {
    test("does not modify the decision", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "single_channel",
        connected,
      );

      expect(enforced.selectedChannels).toEqual(["vellum"]);
      expect(enforced.reasoningSummary).toBe(decision.reasoningSummary);
    });
  });

  describe("undefined routing intent", () => {
    test("does not modify the decision", () => {
      const decision = makeDecision({ selectedChannels: ["vellum"] });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(decision, undefined, connected);

      expect(enforced.selectedChannels).toEqual(["vellum"]);
    });
  });

  describe("copy generation at fire time", () => {
    test("existing rendered copy is preserved through enforcement", () => {
      const decision = makeDecision({
        selectedChannels: ["vellum"],
        renderedCopy: {
          vellum: { title: "Reminder", body: "Pick up groceries" },
        },
      });
      const connected: NotificationChannel[] = ["vellum", "telegram"];

      const enforced = enforceRoutingIntent(
        decision,
        "all_channels",
        connected,
      );

      // Channels expanded but copy from LLM is preserved
      expect(enforced.selectedChannels).toEqual(["vellum", "telegram"]);
      expect(enforced.renderedCopy.vellum?.body).toBe("Pick up groceries");
    });
  });
});
