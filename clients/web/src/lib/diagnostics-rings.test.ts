import { describe, expect, test } from "bun:test";

import {
  buildDiagnosticsSnapshot,
  getDiagnosticsEvents,
  getLifecycleDiagnosticsEvents,
  recordDiagnostic,
  recordLifecycleDiagnostic,
} from "@/lib/diagnostics";

// ---------------------------------------------------------------------------
// Two-ring separation
//
// High-volume per-delta diagnostics must never flush the low-volume
// connection/lifecycle timeline. The two recorders write to independent
// sessionStorage rings so a long streaming session can't evict the
// signals a "stale after refocus" report depends on.
// ---------------------------------------------------------------------------

describe("diagnostics ring separation", () => {
  test("main and lifecycle recorders write to independent rings", () => {
    // GIVEN baseline counts for both rings
    const mainBefore = getDiagnosticsEvents().length;
    const lifecycleBefore = getLifecycleDiagnosticsEvents().length;

    // WHEN a high-volume event and a lifecycle event are each recorded
    recordDiagnostic("ring_test_main", { a: 1 });
    recordLifecycleDiagnostic("ring_test_lifecycle", { b: 2 });

    // THEN each event lands only in its own ring
    const mainAdded = getDiagnosticsEvents().slice(mainBefore);
    const lifecycleAdded = getLifecycleDiagnosticsEvents().slice(
      lifecycleBefore,
    );
    expect(mainAdded.map((e) => e.kind)).toContain("ring_test_main");
    expect(mainAdded.map((e) => e.kind)).not.toContain("ring_test_lifecycle");
    expect(lifecycleAdded.map((e) => e.kind)).toContain("ring_test_lifecycle");
    expect(lifecycleAdded.map((e) => e.kind)).not.toContain("ring_test_main");
  });

  test("lifecycle recorder injects the platform tag like the main recorder", () => {
    // GIVEN a baseline for the lifecycle ring
    const before = getLifecycleDiagnosticsEvents().length;

    // WHEN a lifecycle event is recorded with call-site details
    recordLifecycleDiagnostic("ring_test_platform", { signal: "visibility" });

    // THEN the centralized platform tag is present alongside the details
    const recorded = getLifecycleDiagnosticsEvents().slice(before);
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.details.platform).toBeDefined();
    expect(recorded[0]!.details.signal).toBe("visibility");
  });

  test("snapshot is schema v2 and carries both rings as separate arrays", () => {
    // GIVEN one event recorded into each ring
    recordDiagnostic("ring_test_snapshot_main", {});
    recordLifecycleDiagnostic("ring_test_snapshot_lifecycle", {});

    // WHEN a support snapshot is built
    const snapshot = buildDiagnosticsSnapshot(null);

    // THEN it is versioned and exposes both timelines distinctly
    expect(snapshot.schemaVersion).toBe(2);
    const events = snapshot.events as Array<{ kind: string }>;
    const lifecycleEvents = snapshot.lifecycleEvents as Array<{
      kind: string;
    }>;
    expect(events.map((e) => e.kind)).toContain("ring_test_snapshot_main");
    expect(lifecycleEvents.map((e) => e.kind)).toContain(
      "ring_test_snapshot_lifecycle",
    );
  });
});
