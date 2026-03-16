/**
 * Tests for the conversation seed composer.
 *
 * Validates surface-aware verbosity resolution, copy-based seed
 * composition, and the conversationSeedMessage sanity check.
 */

import { describe, expect, test } from "bun:test";

import {
  composeConversationSeed,
  isConversationSeedSane,
  resolveVerbosity,
} from "../notifications/conversation-seed-composer.js";
import type { NotificationSignal } from "../notifications/signal.js";
import type {
  NotificationChannel,
  RenderedChannelCopy,
} from "../notifications/types.js";

// ── Helpers ────────────────────────────────────────────────────────────

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-seed-001",
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceConversationId: "sess-1",
    sourceEventName: "test.event",
    contextPayload: {},
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

function makeCopy(
  overrides?: Partial<RenderedChannelCopy>,
): RenderedChannelCopy {
  return {
    title: "Test Alert",
    body: "Something happened.",
    ...overrides,
  };
}

// ── resolveVerbosity ───────────────────────────────────────────────────

describe("resolveVerbosity", () => {
  test("vellum channel defaults to rich", () => {
    expect(resolveVerbosity("vellum" as NotificationChannel, {})).toBe("rich");
  });

  test("telegram channel defaults to compact", () => {
    expect(resolveVerbosity("telegram" as NotificationChannel, {})).toBe(
      "compact",
    );
  });

  test("explicit interfaceHint=macos overrides to rich", () => {
    expect(
      resolveVerbosity("telegram" as NotificationChannel, {
        interfaceHint: "macos",
      }),
    ).toBe("rich");
  });

  test("explicit interfaceHint=telegram overrides to compact", () => {
    expect(
      resolveVerbosity("vellum" as NotificationChannel, {
        interfaceHint: "telegram",
      }),
    ).toBe("compact");
  });

  test("explicit interfaceHint=ios resolves to rich", () => {
    expect(
      resolveVerbosity("telegram" as NotificationChannel, {
        interfaceHint: "ios",
      }),
    ).toBe("rich");
  });

  test("sourceInterface is used when interfaceHint is missing", () => {
    expect(
      resolveVerbosity("telegram" as NotificationChannel, {
        sourceInterface: "macos",
      }),
    ).toBe("rich");
  });

  test("interfaceHint takes priority over sourceInterface", () => {
    expect(
      resolveVerbosity("telegram" as NotificationChannel, {
        interfaceHint: "telegram",
        sourceInterface: "macos",
      }),
    ).toBe("compact");
  });

  test("invalid interfaceHint is ignored, falls through to channel default", () => {
    expect(
      resolveVerbosity("vellum" as NotificationChannel, {
        interfaceHint: "not_a_real_interface",
      }),
    ).toBe("rich");
  });

  test("unknown channel without hints defaults to compact", () => {
    expect(resolveVerbosity("phone" as NotificationChannel, {})).toBe(
      "compact",
    );
  });
});

// ── isConversationSeedSane ───────────────────────────────────────────────────

describe("isConversationSeedSane", () => {
  test("accepts a normal string", () => {
    expect(isConversationSeedSane("This is a valid thread seed message.")).toBe(
      true,
    );
  });

  test("rejects empty string", () => {
    expect(isConversationSeedSane("")).toBe(false);
  });

  test("rejects very short string (1-2 chars)", () => {
    expect(isConversationSeedSane("Hi")).toBe(false);
  });

  test("accepts short CJK text (>= 3 chars)", () => {
    // CJK characters pack more meaning per character
    expect(isConversationSeedSane("リマインダー")).toBe(true);
    expect(isConversationSeedSane("提醒您")).toBe(true);
  });

  test("accepts string at min boundary (3 chars)", () => {
    expect(isConversationSeedSane("abc")).toBe(true);
  });

  test("rejects JSON object dump", () => {
    expect(isConversationSeedSane('{"key": "value", "nested": {"a": 1}}')).toBe(
      false,
    );
  });

  test("rejects JSON array dump", () => {
    expect(isConversationSeedSane('[{"item": 1}, {"item": 2}]')).toBe(false);
  });

  test("rejects non-string values", () => {
    expect(isConversationSeedSane(42)).toBe(false);
    expect(isConversationSeedSane(null)).toBe(false);
    expect(isConversationSeedSane(undefined)).toBe(false);
  });

  test("rejects excessively long string", () => {
    expect(isConversationSeedSane("x".repeat(2001))).toBe(false);
  });

  test("accepts string at max boundary", () => {
    expect(isConversationSeedSane("x".repeat(2000))).toBe(true);
  });
});

// ── composeConversationSeed — copy-based composition ─────────────────────────

describe("composeConversationSeed", () => {
  describe("rich verbosity (vellum/macos)", () => {
    test("combines title and body into flowing prose", () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: "Reminder", body: "Take out the trash" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toContain("Reminder");
      expect(seed).toContain("Take out the trash");
      // Should be flowing prose (joined with ". "), not newline-separated
      expect(seed).not.toContain("\n");
    });

    test('appends "Action required." when requiresAction is true', () => {
      const signal = makeSignal({
        attentionHints: {
          requiresAction: true,
          urgency: "high",
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({ title: "Reminder", body: "Call the doctor" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toContain("Action required");
    });

    test('does not duplicate "Action required" when copy already includes it', () => {
      const signal = makeSignal({
        attentionHints: {
          requiresAction: true,
          urgency: "high",
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({
        title: "Guardian Question",
        body: "Action required: What is the gate code?",
      });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      const markerCount = (seed.match(/action required/gi) ?? []).length;
      expect(markerCount).toBe(1);
    });

    test('omits "Notification" generic title', () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: "Notification", body: "Something new." });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).not.toMatch(/^Notification/);
      expect(seed).toContain("Something new");
    });
  });

  describe("compact verbosity (telegram)", () => {
    test("preserves title/body format with newline separator", () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: "Alert", body: "Details here." });
      const seed = composeConversationSeed(
        signal,
        "telegram" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Alert\n\nDetails here.");
    });

    test("does not append action markers", () => {
      const signal = makeSignal({
        attentionHints: {
          requiresAction: true,
          urgency: "high",
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({ title: "Reminder", body: "Respond to email" });
      const seed = composeConversationSeed(
        signal,
        "telegram" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Reminder\n\nRespond to email");
    });
  });

  describe("localization preservation", () => {
    test("preserves localized LLM copy on vellum (rich)", () => {
      const signal = makeSignal();
      const copy = makeCopy({
        title: "リマインダー",
        body: "ゴミを出してください",
      });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toContain("リマインダー");
      expect(seed).toContain("ゴミを出してください");
    });

    test("preserves localized LLM copy on telegram (compact)", () => {
      const signal = makeSignal();
      const copy = makeCopy({
        title: "リマインダー",
        body: "ゴミを出してください",
      });
      const seed = composeConversationSeed(
        signal,
        "telegram" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("リマインダー\n\nゴミを出してください");
    });

    test("does not inject English template strings into localized copy", () => {
      const signal = makeSignal({
        sourceEventName: "guardian.question",
        attentionHints: {
          requiresAction: true,
          urgency: "high",
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({
        title: "ガーディアンの質問",
        body: "ゲートコードは何ですか？",
      });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toContain("ガーディアンの質問");
      expect(seed).toContain("ゲートコードは何ですか？");
      // The only English that may appear is "Action required." which is
      // an intentional structural marker, not a content replacement
    });
  });

  describe("surface-aware verbosity", () => {
    test("vellum seeds are formatted differently than telegram seeds", () => {
      const signal = makeSignal({
        attentionHints: {
          requiresAction: true,
          urgency: "high",
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
      });
      const copy = makeCopy({
        title: "Reminder",
        body: "Important meeting at 3pm",
      });
      const richSeed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      const compactSeed = composeConversationSeed(
        signal,
        "telegram" as NotificationChannel,
        copy,
      );
      // Rich has action note, compact does not
      expect(richSeed).toContain("Action required");
      expect(compactSeed).not.toContain("Action required");
    });

    test("interfaceHint in contextPayload overrides channel default", () => {
      const signal = makeSignal({
        contextPayload: { interfaceHint: "telegram" },
      });
      const copy = makeCopy({ title: "Alert", body: "Details." });
      // Channel is vellum but interfaceHint says telegram → compact format
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Alert\n\nDetails.");
    });
  });

  describe("edge cases", () => {
    test("handles empty copy body gracefully", () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: "Alert", body: "" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed.length).toBeGreaterThan(0);
    });

    test("never produces raw JSON in output", () => {
      const signal = makeSignal();
      const copy = makeCopy({ title: "Alert", body: "Check the results." });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).not.toMatch(/^\{/);
      expect(seed).not.toMatch(/^\[/);
    });
  });

  describe("empty copy fallback", () => {
    test("falls back to event name when both title and body are empty", () => {
      const signal = makeSignal({ sourceEventName: "schedule.notify" });
      const copy = makeCopy({ title: "", body: "" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Schedule notify");
    });

    test('falls back to event name when title is "Notification" and body is empty', () => {
      const signal = makeSignal({ sourceEventName: "schedule.complete" });
      const copy = makeCopy({ title: "Notification", body: "" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Schedule complete");
    });

    test('uses context payload "message" field in fallback when available', () => {
      const signal = makeSignal({
        sourceEventName: "schedule.notify",
        contextPayload: { message: "Take out the trash" },
      });
      const copy = makeCopy({ title: "", body: "" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Schedule notify: Take out the trash");
    });

    test('uses context payload "summary" field in fallback', () => {
      const signal = makeSignal({
        sourceEventName: "activity.complete",
        contextPayload: { summary: "Deployed v2.3.1 successfully" },
      });
      const copy = makeCopy({ title: "", body: "" });
      const seed = composeConversationSeed(
        signal,
        "telegram" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Activity complete: Deployed v2.3.1 successfully");
    });

    test('uses context payload "questionText" field for guardian events', () => {
      const signal = makeSignal({
        sourceEventName: "guardian.question",
        contextPayload: { questionText: "What is the gate code?" },
      });
      const copy = makeCopy({ title: "", body: "" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Guardian question: What is the gate code?");
    });

    test("fallback is consistent across rich and compact channels", () => {
      const signal = makeSignal({
        sourceEventName: "schedule.notify",
        contextPayload: { message: "Call the doctor" },
      });
      const copy = makeCopy({ title: "", body: "" });
      const richSeed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      const compactSeed = composeConversationSeed(
        signal,
        "telegram" as NotificationChannel,
        copy,
      );
      // Both should produce the same context-based fallback
      expect(richSeed).toBe(compactSeed);
    });

    test("fallback handles whitespace-only copy", () => {
      const signal = makeSignal({ sourceEventName: "watcher.notification" });
      const copy = makeCopy({ title: "   ", body: "  " });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Watcher notification");
    });

    test("fallback never produces blank content", () => {
      const signal = makeSignal({
        sourceEventName: "unknown.event",
        contextPayload: {},
      });
      const copy = makeCopy({ title: "", body: "" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed.trim().length).toBeGreaterThan(0);
    });

    test('uses context payload "senderIdentifier" for escalation events', () => {
      const signal = makeSignal({
        sourceEventName: "ingress.escalation",
        contextPayload: { senderIdentifier: "Alice" },
      });
      const copy = makeCopy({ title: "", body: "" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Ingress escalation: Alice");
    });

    test('prefers "message" over "summary" in context payload', () => {
      const signal = makeSignal({
        sourceEventName: "test.event",
        contextPayload: {
          message: "Primary message",
          summary: "Secondary summary",
        },
      });
      const copy = makeCopy({ title: "", body: "" });
      const seed = composeConversationSeed(
        signal,
        "vellum" as NotificationChannel,
        copy,
      );
      expect(seed).toBe("Test event: Primary message");
    });
  });
});
