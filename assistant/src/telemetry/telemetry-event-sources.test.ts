/**
 * Pins the daemon/monitor partition of the telemetry event sources: every
 * source is flushed by exactly one process, turns stay in the daemon (their
 * completeness barrier and trace assembly read live in-memory conversation
 * state), and payload order is preserved.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import { recordOnboardingResearchEvent } from "../onboarding/onboarding-research-events-store.js";
import {
  pendingOutboxRows,
  resetOutboxTable,
  setShareAnalytics,
  setShareDiagnostics,
} from "./__tests__/outbox-test-harness.js";
import {
  ALL_TELEMETRY_EVENT_SOURCES,
  DAEMON_TELEMETRY_EVENT_SOURCES,
  MONITOR_TELEMETRY_EVENT_SOURCES,
  ORPHAN_OUTBOX_DRAIN_SOURCE_ID,
  orphanOutboxDrainSource,
} from "./telemetry-event-sources.js";
import { insertTelemetryOutboxEvents } from "./telemetry-events-outbox.js";
import { telemetryEventSchema } from "./telemetry-wire.generated.js";
import type { TelemetryEvent } from "./types.js";
import {
  OUTBOX_TELEMETRY_EVENT_NAMES,
  WATERMARK_TELEMETRY_EVENT_NAMES,
} from "./types.js";

describe("telemetry event source partition", () => {
  test("the full source list carries every event type in payload order", () => {
    // Watermark sources first (their ids are the table names, not the wire
    // discriminants), then outbox events in wire-contract order, then the
    // synthetic orphan-drain source last.
    expect(ALL_TELEMETRY_EVENT_SOURCES.map((s) => s.id)).toEqual([
      "usage",
      "turns",
      "tool_executed",
      "lifecycle",
      "onboarding",
      "auth_fallback",
      "skill_loaded",
      "watchdog",
      "config_setting",
      "onboarding_research",
      ORPHAN_OUTBOX_DRAIN_SOURCE_ID,
    ]);
  });

  test("every wire event type is partitioned to exactly one flush lane", () => {
    // The derivation's core guarantee: a new wire event type can't silently go
    // unflushed. Every discriminant in the generated contract is either
    // watermark-flushed or (by default) outbox-backed, never both, never
    // neither — and, ignoring the synthetic orphan-drain source, the counts
    // line up with one source per type.
    const wireTypes = new Set(
      telemetryEventSchema.options.map((o) => o.shape.type.value),
    );
    const partitioned = [
      ...WATERMARK_TELEMETRY_EVENT_NAMES,
      ...OUTBOX_TELEMETRY_EVENT_NAMES,
    ];
    expect(new Set(partitioned)).toEqual(wireTypes);
    expect(partitioned.length).toBe(wireTypes.size); // disjoint: no double-count
    const perTypeSources = ALL_TELEMETRY_EVENT_SOURCES.filter(
      (s) => s.id !== ORPHAN_OUTBOX_DRAIN_SOURCE_ID,
    );
    expect(perTypeSources.length).toBe(wireTypes.size);
  });

  test("every watermark name is a real wire discriminant", () => {
    // Guards a stale/typo watermark name that would wrongly exclude a live type
    // from the outbox (and thus from any flush source).
    const wireTypes = new Set(
      telemetryEventSchema.options.map((o) => o.shape.type.value),
    );
    for (const name of WATERMARK_TELEMETRY_EVENT_NAMES) {
      expect(wireTypes.has(name)).toBe(true);
    }
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

describe("onboarding_research source: flushes via the default outbox source", () => {
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

  test("ships pending rows regardless of diagnostics consent, like every other outbox event", () => {
    // No flush-time diagnostics gate: the daemon rides `share_analytics`
    // only and leaves the diagnostics decision to the platform's
    // authoritative server-side ingest gate. Diagnostics off (and even a
    // stale accepted version) must not hold the row back.
    setShareDiagnostics(false, "2000-01-01");
    recordSample();

    const batch = onboardingResearchSource().collect(0, undefined, 100);
    expect(batch.events).toHaveLength(1);
  });
});

describe("orphan-drain source", () => {
  beforeEach(() => {
    resetOutboxTable();
    setShareAnalytics(true);
  });

  function insertOutboxRow(name: string, id: string): void {
    insertTelemetryOutboxEvents([
      {
        id,
        name,
        createdAt: 1,
        event: {
          type: name,
          daemon_event_id: id,
          recorded_at: 1,
          assistant_version: "1.2.3",
        } as unknown as TelemetryEvent,
      },
    ]);
  }

  test("drains rows for a type no longer in the wire contract, then self-heals on ack", () => {
    // A row whose name isn't a current outbox event type — e.g. recorded before
    // the platform removed the type. No per-type source queries it.
    const orphanName = "removed_legacy_event";
    insertOutboxRow(orphanName, "orphan-row-1");

    const source = orphanOutboxDrainSource();
    const batch = source.collect(0, undefined, 500);
    expect(batch.events).toHaveLength(1);
    expect((batch.events[0] as { type: string }).type).toBe(orphanName);
    expect(batch.rowIds).toEqual(["orphan-row-1"]);

    // Send-then-ack: the reporter deletes the row after a 2xx, so it self-heals.
    source.ack?.acknowledge(batch.rowIds ?? []);
    expect(pendingOutboxRows(orphanName)).toHaveLength(0);
  });

  test("ignores rows for a current outbox event type", () => {
    // Known types drain through their own per-type source, not this one.
    const knownName = OUTBOX_TELEMETRY_EVENT_NAMES[0];
    insertOutboxRow(knownName, "known-row-1");
    const batch = orphanOutboxDrainSource().collect(0, undefined, 500);
    expect(batch.events).toHaveLength(0);
  });

  test("is registered in the monitor partition", () => {
    expect(
      MONITOR_TELEMETRY_EVENT_SOURCES.some(
        (s) => s.id === ORPHAN_OUTBOX_DRAIN_SOURCE_ID,
      ),
    ).toBe(true);
  });
});
