/**
 * Tests for the notification copy-composer — specifically the fallback
 * path that composeFallbackCopy uses when the LLM is unavailable, and
 * the shared deriveTitle utility.
 */

import { describe, expect, test } from "bun:test";

import { composeFallbackCopy, deriveTitle } from "../copy-composer.js";
import type { NotificationSignal } from "../signal.js";
import type { NotificationChannel } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-copy-test-1",
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceContextId: "ctx-1",
    sourceEventName: "user.send_notification",
    contextPayload: {},
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

const CHANNELS: NotificationChannel[] = ["vellum" as NotificationChannel];

// ── composeFallbackCopy with requestedMessage ─────────────────────────

describe("composeFallbackCopy honors requestedMessage / requestedTitle", () => {
  test("uses requestedMessage as body and requestedTitle as title", () => {
    const signal = makeSignal({
      contextPayload: {
        requestedMessage: "Take out the trash",
        requestedTitle: "Household Reminder",
      },
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.body).toBe("Take out the trash");
    expect(copy.vellum?.title).toBe("Household Reminder");
    expect(copy.vellum?.conversationSeedMessage).toBe("Take out the trash");
  });

  test("derives title from body when requestedTitle is absent", () => {
    const signal = makeSignal({
      contextPayload: {
        requestedMessage: "First sentence. Second sentence follows.",
      },
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.body).toBe("First sentence. Second sentence follows.");
    expect(copy.vellum?.title).toBe("First sentence.");
  });

  test("derives title from body when requestedTitle is empty string", () => {
    const signal = makeSignal({
      contextPayload: {
        requestedMessage: "Some message body here",
        requestedTitle: "",
      },
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.body).toBe("Some message body here");
    expect(copy.vellum?.title).toBe("Some message body here");
  });

  test("derives title from body when requestedTitle is whitespace", () => {
    const signal = makeSignal({
      contextPayload: {
        requestedMessage: "Whitespace title test",
        requestedTitle: "   ",
      },
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.body).toBe("Whitespace title test");
    expect(copy.vellum?.title).toBe("Whitespace title test");
  });

  test("trims whitespace from requestedMessage", () => {
    const signal = makeSignal({
      contextPayload: {
        requestedMessage: "  padded message  ",
        requestedTitle: "  padded title  ",
      },
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.body).toBe("padded message");
    expect(copy.vellum?.title).toBe("padded title");
  });

  test("populates copy for all requested channels", () => {
    const channels = [
      "vellum" as NotificationChannel,
      "telegram" as NotificationChannel,
    ];
    const signal = makeSignal({
      contextPayload: {
        requestedMessage: "Multi-channel test",
        requestedTitle: "Multi Title",
      },
    });
    const copy = composeFallbackCopy(signal, channels);

    expect(copy.vellum?.body).toBe("Multi-channel test");
    expect(copy.vellum?.title).toBe("Multi Title");
    expect(copy.telegram?.body).toBe("Multi-channel test");
    expect(copy.telegram?.title).toBe("Multi Title");
  });

  test("falls through to template when requestedMessage is absent", () => {
    const signal = makeSignal({
      sourceEventName: "schedule.notify",
      contextPayload: {
        message: "Standup time",
        label: "Daily Standup",
      },
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.title).toBe("Daily Standup");
    expect(copy.vellum?.body).toBe("Standup time");
  });

  test("falls through to template when requestedMessage is empty string", () => {
    const signal = makeSignal({
      sourceEventName: "schedule.notify",
      contextPayload: {
        requestedMessage: "",
        message: "Standup time",
      },
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.title).toBe("Reminder");
    expect(copy.vellum?.body).toBe("Standup time");
  });

  test("falls through to template when requestedMessage is whitespace", () => {
    const signal = makeSignal({
      sourceEventName: "schedule.notify",
      contextPayload: {
        requestedMessage: "   ",
        message: "Standup time",
      },
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.title).toBe("Reminder");
    expect(copy.vellum?.body).toBe("Standup time");
  });

  test("falls through to generic copy when no requestedMessage and no template match", () => {
    const signal = makeSignal({
      sourceEventName: "unknown.event",
      contextPayload: {},
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.title).toBe("Notification");
    expect(copy.vellum?.body).toBe("");
  });

  test("requestedMessage takes priority over event-name template", () => {
    const signal = makeSignal({
      sourceEventName: "schedule.notify",
      contextPayload: {
        requestedMessage: "User-supplied content",
        requestedTitle: "User Title",
        message: "Template message field",
        label: "Template label field",
      },
    });
    const copy = composeFallbackCopy(signal, CHANNELS);

    expect(copy.vellum?.body).toBe("User-supplied content");
    expect(copy.vellum?.title).toBe("User Title");
  });

  test("works with non-assistant_tool source channels", () => {
    for (const sourceChannel of ["scheduler", "watcher", "slack"] as const) {
      const signal = makeSignal({
        sourceChannel,
        contextPayload: {
          requestedMessage: `Message from ${sourceChannel}`,
        },
      });
      const copy = composeFallbackCopy(signal, CHANNELS);

      expect(copy.vellum?.body).toBe(`Message from ${sourceChannel}`);
    }
  });
});

// ── deriveTitle ───────────────────────────────────────────────────────

describe("deriveTitle", () => {
  test("extracts first sentence when period is present", () => {
    expect(deriveTitle("First sentence. Second sentence.")).toBe(
      "First sentence.",
    );
  });

  test("extracts first sentence on exclamation mark", () => {
    expect(deriveTitle("Alert! More details follow.")).toBe("Alert!");
  });

  test("extracts first sentence on question mark", () => {
    expect(deriveTitle("Ready? Let me know.")).toBe("Ready?");
  });

  test("uses full body when no sentence terminator", () => {
    expect(deriveTitle("No terminator here")).toBe("No terminator here");
  });

  test("truncates to 60 characters with ellipsis", () => {
    const long = "A".repeat(80);
    const result = deriveTitle(long);
    expect(result.length).toBeLessThanOrEqual(61); // 60 + ellipsis char
    expect(result.endsWith("\u2026")).toBe(true);
  });

  test("does not truncate at exactly 60 characters", () => {
    const exact = "A".repeat(60);
    expect(deriveTitle(exact)).toBe(exact);
  });

  test("trims whitespace", () => {
    expect(deriveTitle("  trimmed  ")).toBe("trimmed");
  });
});
