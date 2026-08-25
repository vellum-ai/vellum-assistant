import { describe, expect, test } from "bun:test";

import { NOTIFICATION_SOURCE_EVENT_NAMES } from "../signal.js";

const ids = new Set<string>(NOTIFICATION_SOURCE_EVENT_NAMES.map((e) => e.id));

describe("NOTIFICATION_SOURCE_EVENT_NAMES", () => {
  test("carries the run lifecycle transitions that notify", () => {
    expect(ids.has("run.needs_input")).toBe(true);
    expect(ids.has("run.failed")).toBe(true);
    expect(ids.has("run.finished_notable")).toBe(true);
  });

  test.each([
    // Per-failure background-job notifications: not actionable, and they
    // repeated forever because the dedupe window resets daily. Failures roll
    // into a System health counter instead.
    "activity.failed",
    "activity.complete",
    // Bookkeeping for something the user never asked about.
    "schedule.declared",
    "schedule.definition_changed",
    // A plugin author's problem, reported through System health.
    "schedule.definition_error",
    // Suppressed every single time it fired; the guardian already has the code.
    "ingress.trusted_contact.verification_sent",
    // The surface the user is already looking at IS the notification.
    "quick_chat.response_ready",
    "voice.response_ready",
    // A webhook cannot be repaired from a notification.
    "telegram.webhook_health_alert",
  ])("no longer registers %s", (retired) => {
    expect(ids.has(retired)).toBe(false);
  });
});
