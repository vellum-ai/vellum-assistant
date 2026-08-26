import { describe, expect, test } from "bun:test";

import { bucketCompat, bucketExpiresAt, deriveBucket } from "../bucket.js";
import type { AttentionHints } from "../signal.js";

function hints(overrides: Partial<AttentionHints> = {}): AttentionHints {
  return {
    requiresAction: false,
    urgency: "medium",
    isAsyncBackground: false,
    visibleInSourceNow: false,
    ...overrides,
  };
}

describe("deriveBucket", () => {
  test.each([
    "guardian.question",
    "guardian.channel_activation",
    "ingress.access_request",
    "ingress.access_request.callback_handoff",
    "credential.health_alert",
    "tool_confirmation.required_action",
    "run.needs_input",
  ])("%s blocks the user", (sourceEventName) => {
    expect(
      deriveBucket({ sourceEventName, attentionHints: hints() }),
    ).toBe("needs_you");
  });

  test.each([
    "user.send_notification",
    "schedule.notify",
    "watcher.notification",
    "watcher.escalation",
    "chat.assistant_reply",
    "run.finished_notable",
    "run.failed",
  ])("%s is worth knowing", (sourceEventName) => {
    expect(deriveBucket({ sourceEventName, attentionHints: hints() })).toBe(
      "worth_knowing",
    );
  });

  test("anything else is activity", () => {
    expect(
      deriveBucket({
        sourceEventName: "ingress.trusted_contact.activated",
        attentionHints: hints(),
      }),
    ).toBe("activity");
  });

  test("a signal declaring it blocks the user reaches the top section on its own", () => {
    // The rule is about the signal, not the registry: a producer that says
    // its work is blocked gets Needs you whatever its event is called.
    expect(
      deriveBucket({
        sourceEventName: "some.unregistered.event",
        attentionHints: hints({ requiresAction: true }),
      }),
    ).toBe("needs_you");
  });

  test("urgency alone never promotes a signal", () => {
    // Urgency drives how loudly a notification is delivered, not which
    // section it lands in. A critical-but-unactionable signal is still
    // activity, which is the whole reason the two are separate fields.
    expect(
      deriveBucket({
        sourceEventName: "some.unregistered.event",
        attentionHints: hints({ urgency: "critical" }),
      }),
    ).toBe("activity");
  });

  test("is total and stable: the same signal always lands in the same section", () => {
    const signal = {
      sourceEventName: "schedule.notify",
      attentionHints: hints(),
    };
    expect(deriveBucket(signal)).toBe(deriveBucket(signal));
  });
});

describe("bucketCompat", () => {
  test("sections never interleave under the legacy sort", () => {
    const needsYou = bucketCompat("needs_you");
    const worthKnowing = bucketCompat("worth_knowing");
    const activity = bucketCompat("activity");

    expect(needsYou.priority).toBeGreaterThan(worthKnowing.priority);
    expect(worthKnowing.priority).toBeGreaterThan(activity.priority);
  });

  test("noteworthy is the inbox-versus-activity split, projected", () => {
    expect(bucketCompat("needs_you").noteworthy).toBe(true);
    expect(bucketCompat("worth_knowing").noteworthy).toBe(true);
    expect(bucketCompat("activity").noteworthy).toBe(false);
  });
});

describe("bucketExpiresAt", () => {
  const NOW = Date.parse("2026-08-25T12:00:00.000Z");

  test("a needs-you row expires on resolution, not on a clock", () => {
    expect(bucketExpiresAt("needs_you", NOW)).toBeUndefined();
  });

  test("worth knowing lasts a week, activity two days", () => {
    expect(bucketExpiresAt("worth_knowing", NOW)).toBe(
      new Date(NOW + 7 * 24 * 60 * 60 * 1000).toISOString(),
    );
    expect(bucketExpiresAt("activity", NOW)).toBe(
      new Date(NOW + 48 * 60 * 60 * 1000).toISOString(),
    );
  });
});
