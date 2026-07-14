/**
 * Pins the daemon/monitor partition of the telemetry event sources: every
 * source is flushed by exactly one process, turns stay in the daemon (their
 * completeness barrier and trace assembly read live in-memory conversation
 * state), and payload order is preserved.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { recordOnboardingResearchEvent } from "../onboarding/onboarding-research-events-store.js";
import {
  resetOutboxTable,
  setShareAnalytics,
  setShareDiagnostics,
} from "./__tests__/outbox-test-harness.js";
import {
  ALL_TELEMETRY_EVENT_SOURCES,
  DAEMON_TELEMETRY_EVENT_SOURCES,
  MONITOR_TELEMETRY_EVENT_SOURCES,
} from "./telemetry-event-sources.js";
import { OUTBOX_TELEMETRY_EVENT_NAMES } from "./types.js";

describe("telemetry event source partition", () => {
  test("the full source list carries every event type in payload order", () => {
    expect(ALL_TELEMETRY_EVENT_SOURCES.map((s) => s.id)).toEqual([
      "usage",
      "turns",
      "lifecycle",
      "onboarding",
      "auth_fallback",
      "tool_executed",
      "skill_loaded",
      "watchdog",
      "config_setting",
      "onboarding_research",
    ]);
  });

  test("the daemon flushes turns only", () => {
    expect(DAEMON_TELEMETRY_EVENT_SOURCES.map((s) => s.id)).toEqual(["turns"]);
  });

  test("the monitor flushes everything else, order preserved", () => {
    expect(MONITOR_TELEMETRY_EVENT_SOURCES.map((s) => s.id)).toEqual(
      ALL_TELEMETRY_EVENT_SOURCES.map((s) => s.id).filter(
        (id) => id !== "turns",
      ),
    );
  });

  test("every outbox event name has a registered source", () => {
    const sourceIds = new Set(ALL_TELEMETRY_EVENT_SOURCES.map((s) => s.id));
    for (const name of OUTBOX_TELEMETRY_EVENT_NAMES) {
      expect(sourceIds.has(name)).toBe(true);
    }
  });

  test("daemon and monitor partition the full list — no overlap, no gaps", () => {
    const daemonIds = new Set(DAEMON_TELEMETRY_EVENT_SOURCES.map((s) => s.id));
    const monitorIds = new Set(
      MONITOR_TELEMETRY_EVENT_SOURCES.map((s) => s.id),
    );
    for (const id of daemonIds) {
      expect(monitorIds.has(id)).toBe(false);
    }
    expect(daemonIds.size + monitorIds.size).toBe(
      ALL_TELEMETRY_EVENT_SOURCES.length,
    );
  });
});

describe("onboarding_research source: flush-time diagnostics gate", () => {
  beforeEach(() => {
    setShareAnalytics(true);
    setShareDiagnostics(true);
    resetOutboxTable();
  });

  function onboardingResearchSource() {
    const source = ALL_TELEMETRY_EVENT_SOURCES.find(
      (s) => s.id === "onboarding_research",
    );
    if (!source) {
      throw new Error("onboarding_research source not registered");
    }
    return source;
  }

  function recordSample(): void {
    recordOnboardingResearchEvent({
      conversationId: "conv-x",
      status: "done",
      claims: [],
      suggestions: [],
      plugins: [],
      installedPlugins: [],
    });
  }

  test("ships normally when diagnostics consent is eligible", () => {
    recordSample();
    const batch = onboardingResearchSource().collect(0, undefined, 100);
    expect(batch.events).toHaveLength(1);
  });

  test("purges pending rows outright once diagnostics consent is revoked before flush, rather than shipping them", () => {
    recordSample();
    // Consent was on at record time — the row is already pending — then
    // revoked before the reporter gets to flush it.
    setShareDiagnostics(false);

    const batch = onboardingResearchSource().collect(0, undefined, 100);
    expect(batch.events).toHaveLength(0);

    // Purged, not merely skipped: a later collect (e.g. consent flips back
    // on) must never resurrect the stale pre-revocation row.
    setShareDiagnostics(true);
    const secondBatch = onboardingResearchSource().collect(0, undefined, 100);
    expect(secondBatch.events).toHaveLength(0);
  });

  test("purges pending rows when the accepted diagnostics-consent version becomes stale before flush", () => {
    recordSample();
    setShareDiagnostics(true, "2000-01-01");

    const batch = onboardingResearchSource().collect(0, undefined, 100);
    expect(batch.events).toHaveLength(0);
  });
});
