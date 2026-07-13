/**
 * Pins the daemon/monitor partition of the telemetry event sources: every
 * source is flushed by exactly one process, turns stay in the daemon (their
 * completeness barrier and trace assembly read live in-memory conversation
 * state), and payload order is preserved.
 */
import { describe, expect, test } from "bun:test";

import {
  ALL_TELEMETRY_EVENT_SOURCES,
  DAEMON_TELEMETRY_EVENT_SOURCES,
  MONITOR_TELEMETRY_EVENT_SOURCES,
} from "./telemetry-event-sources.js";

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
