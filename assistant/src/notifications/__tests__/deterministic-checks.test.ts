/**
 * Tests for the deterministic pre-send checks.
 *
 * Focus: the rendered-copy quality check that suppresses notifications
 * with empty bodies or bodies that leak the raw source event name
 * (the `buildGenericCopy` fallback path).
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { getDb } from "../../persistence/db-connection.js";
import { initializeDb } from "../../persistence/db-init.js";
import { notificationEvents } from "../../persistence/schema/index.js";
import {
  checkSourceActiveSuppression,
  type DeterministicCheckContext,
  runDeterministicChecks,
} from "../deterministic-checks.js";
import type { NotificationSignal } from "../signal.js";
import type { NotificationDecision } from "../types.js";

await initializeDb();

beforeEach(() => {
  getDb().delete(notificationEvents).run();
});

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: `sig-${crypto.randomUUID()}`,
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceContextId: "ctx-1",
    sourceEventName: "schedule.notify",
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

function makeDecision(
  overrides?: Partial<NotificationDecision>,
): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: ["vellum"],
    reasoningSummary: "test",
    renderedCopy: {
      vellum: { title: "Reminder", body: "Time to drink water" },
    },
    dedupeKey: `dk-${crypto.randomUUID()}`,
    confidence: 0.9,
    fallbackUsed: false,
    ...overrides,
  };
}

const context: DeterministicCheckContext = {
  connectedChannels: ["vellum"],
};

describe("checkRenderedCopyQuality (via runDeterministicChecks)", () => {
  test("passes when body is real non-empty text", async () => {
    const result = await runDeterministicChecks(
      makeSignal(),
      makeDecision(),
      context,
    );
    expect(result.passed).toBe(true);
  });

  test("fails when body is empty", async () => {
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Reminder", body: "" },
      },
    });
    const result = await runDeterministicChecks(
      makeSignal(),
      decision,
      context,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("empty");
  });

  test("fails when body is whitespace only", async () => {
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Reminder", body: "   \n  " },
      },
    });
    const result = await runDeterministicChecks(
      makeSignal(),
      decision,
      context,
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("empty");
  });

  test("fails when body is the raw source event name", async () => {
    const signal = makeSignal({ sourceEventName: "user.send_notification" });
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Reminder", body: "user.send_notification" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("fallback leak");
  });

  test("fails when body matches the normalized source event name", async () => {
    const signal = makeSignal({ sourceEventName: "user.send_notification" });
    const decision = makeDecision({
      renderedCopy: {
        vellum: { title: "Reminder", body: "user send notification" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("fallback leak");
  });

  test("passes when channel was appended post-decision (urgency-forced vellum prepend)", async () => {
    // Regression: emit-signal.ts prepends `vellum` to selectedChannels for
    // high/critical urgency without populating renderedCopy.vellum. The
    // broadcaster's composeFallbackCopy rescue handles those channels at
    // delivery time, so the deterministic check must not fail-closed here.
    const signal = makeSignal({
      attentionHints: {
        requiresAction: false,
        urgency: "high",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
    });
    const decision = makeDecision({
      selectedChannels: ["vellum", "telegram"],
      renderedCopy: {
        telegram: { title: "Reminder", body: "Time to drink water" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, {
      connectedChannels: ["vellum", "telegram"],
    });
    expect(result.passed).toBe(true);
  });

  test("passes when enforceRoutingIntent expanded channels post-decision", async () => {
    // Regression: enforceRoutingIntent can expand selectedChannels to
    // all_channels / multi_channel without populating renderedCopy for the
    // added channels. Broadcaster fallback covers them — check must allow.
    const decision = makeDecision({
      selectedChannels: ["vellum", "telegram", "slack"],
      renderedCopy: {
        vellum: { title: "Reminder", body: "Time to drink water" },
      },
    });
    const result = await runDeterministicChecks(makeSignal(), decision, {
      connectedChannels: ["vellum", "telegram", "slack"],
    });
    expect(result.passed).toBe(true);
  });

  test("still validates body quality for channels with rendered copy", async () => {
    // Even when some channels lack copy (broadcaster fallback territory),
    // channels that DO have copy must still pass the empty/event-name checks.
    const signal = makeSignal({ sourceEventName: "user.send_notification" });
    const decision = makeDecision({
      selectedChannels: ["vellum", "telegram"],
      renderedCopy: {
        telegram: { title: "Reminder", body: "user.send_notification" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, {
      connectedChannels: ["vellum", "telegram"],
    });
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("fallback leak");
  });

  test("fails when no selected channel has copy and fallback body is empty", async () => {
    // Silent-no-delivery guard: if every selected channel is missing from
    // renderedCopy AND the broadcaster's composeFallbackCopy can't produce
    // a usable body (no template for sourceEventName → buildGenericCopy
    // returns body=""), the gate must fail-closed rather than letting
    // dispatchDecision report 0/N sent.
    const signal = makeSignal({ sourceEventName: "user.send_notification" });
    const decision = makeDecision({
      selectedChannels: ["vellum"],
      renderedCopy: {},
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("fallback");
  });

  test("passes when no selected channel has copy but fallback yields a usable body", async () => {
    // schedule.notify has a copy-composer template that produces a usable
    // body even with empty payload — the broadcaster's fallback path will
    // deliver, so the deterministic gate must allow it through.
    const signal = makeSignal({ sourceEventName: "schedule.notify" });
    const decision = makeDecision({
      selectedChannels: ["vellum"],
      renderedCopy: {},
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(true);
  });

  test("passes when shouldNotify is false regardless of copy contents", async () => {
    const signal = makeSignal({ sourceEventName: "user.send_notification" });
    const decision = makeDecision({
      shouldNotify: false,
      // Empty body + event-name body would both fail the copy check if
      // shouldNotify were true. Short-circuit must skip the check.
      renderedCopy: {
        vellum: { title: "", body: "" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(true);
  });

  test("passes assistant_tool pass-through even when body matches normalized event name", async () => {
    // The pass-through path produces verbatim user-supplied body text.
    // A coincidental match with the source event name is the user's
    // intent, not a fallback leak — the check must not suppress it.
    const signal = makeSignal({
      sourceChannel: "assistant_tool",
      sourceEventName: "assistant.share",
    });
    const decision = makeDecision({
      reasoningSummary: "assistant_tool pass-through",
      renderedCopy: {
        vellum: { title: "Assistant share", body: "assistant share" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(true);
  });

  test("fails assistant_tool pass-through with empty body (empty-body branch still fires)", async () => {
    const signal = makeSignal({ sourceChannel: "assistant_tool" });
    const decision = makeDecision({
      reasoningSummary: "assistant_tool pass-through",
      renderedCopy: {
        vellum: { title: "Reminder", body: "" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("empty");
  });

  test("still fails non-pass-through decision when body matches event name", async () => {
    // Regression guard: the pass-through short-circuit must not weaken
    // the check for LLM/fallback paths.
    const signal = makeSignal({ sourceEventName: "user.send_notification" });
    const decision = makeDecision({
      reasoningSummary: "llm classification",
      renderedCopy: {
        vellum: { title: "Reminder", body: "user.send_notification" },
      },
    });
    const result = await runDeterministicChecks(signal, decision, context);
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("fallback leak");
  });
});

describe("checkSourceActiveSuppression (pre-decision gate)", () => {
  test("fails when visibleInSourceNow is set", () => {
    const result = checkSourceActiveSuppression(
      makeSignal({
        attentionHints: {
          requiresAction: false,
          urgency: "low",
          isAsyncBackground: true,
          visibleInSourceNow: true,
        },
      }),
    );
    expect(result.passed).toBe(false);
    expect(result.reason).toContain("Source-active suppression");
  });

  test("passes when visibleInSourceNow is false", () => {
    expect(checkSourceActiveSuppression(makeSignal()).passed).toBe(true);
  });

  test("runDeterministicChecks does not suppress source-active signals (handled by the pre-decision gate)", async () => {
    // Source-active suppression is enforced by the pre-decision gate in
    // emitNotificationSignal, not by this stage. A source-active signal
    // evaluated here therefore passes — this stage only validates the decision.
    const signal = makeSignal({
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: true,
        visibleInSourceNow: true,
      },
    });
    const result = await runDeterministicChecks(
      signal,
      makeDecision(),
      context,
    );
    expect(result.passed).toBe(true);
  });
});
