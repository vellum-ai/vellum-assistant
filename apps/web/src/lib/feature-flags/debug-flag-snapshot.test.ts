/**
 * Tests for the debug-flag snapshot captured in the feedback tar.
 *
 * The snapshot exists so a feedback report carries the exact client
 * debug-flag state, since the flags are localStorage-only overrides with no
 * server record. These tests pin that both the resolved effective values and
 * the raw `vellum:debug:*` overrides are captured, including the default case
 * where no override is set.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { buildDebugFlagSnapshot } from "@/lib/feature-flags/debug-flag-snapshot";

const SEQ_GAP_KEY = "vellum:debug:seqGapDetection";
const IMPERSONATE_KEY = "vellum:debug:impersonateAssistantVersion";

function clearDebugKeys(): void {
  window.localStorage.removeItem(SEQ_GAP_KEY);
  window.localStorage.removeItem(IMPERSONATE_KEY);
}

describe("debug-flag-snapshot", () => {
  beforeEach(clearDebugKeys);
  afterEach(clearDebugKeys);

  test("captures resolved defaults when no override is set", () => {
    // GIVEN no debug overrides have been written

    // WHEN a snapshot is built
    const snapshot = buildDebugFlagSnapshot();

    // THEN the resolved values reflect the code-level defaults...
    expect(snapshot.resolved.seqGapDetection).toBe(false);
    expect(snapshot.resolved.impersonateAssistantVersion).toBeNull();
    // ...and no raw debug overrides are present
    expect(snapshot.overrides).toEqual({});
    expect(typeof snapshot.collectedAt).toBe("string");
  });

  test("captures resolved values and raw overrides when flags are set", () => {
    // GIVEN both debug flags have explicit overrides
    window.localStorage.setItem(SEQ_GAP_KEY, "true");
    window.localStorage.setItem(IMPERSONATE_KEY, "0.8.6");

    // WHEN a snapshot is built
    const snapshot = buildDebugFlagSnapshot();

    // THEN the resolved values reflect the overrides...
    expect(snapshot.resolved.seqGapDetection).toBe(true);
    expect(snapshot.resolved.impersonateAssistantVersion).toBe("0.8.6");
    // ...and the raw entries are captured verbatim under their full keys
    expect(snapshot.overrides).toEqual({
      [SEQ_GAP_KEY]: "true",
      [IMPERSONATE_KEY]: "0.8.6",
    });
  });

  test("scans the vellum:debug:* namespace generically", () => {
    // GIVEN a debug override the snapshot has no dedicated accessor for, plus
    // an unrelated key outside the debug namespace
    window.localStorage.setItem("vellum:debug:futureFlag", "experimental");
    window.localStorage.setItem("vellum:sidebar:collapsed", "true");

    // WHEN a snapshot is built
    const snapshot = buildDebugFlagSnapshot();

    // THEN the unknown debug flag is captured without any code change...
    expect(snapshot.overrides["vellum:debug:futureFlag"]).toBe("experimental");
    // ...and keys outside the debug namespace are excluded
    expect(snapshot.overrides["vellum:sidebar:collapsed"]).toBeUndefined();

    window.localStorage.removeItem("vellum:debug:futureFlag");
    window.localStorage.removeItem("vellum:sidebar:collapsed");
  });
});
