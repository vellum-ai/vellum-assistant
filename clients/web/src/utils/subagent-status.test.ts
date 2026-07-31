/**
 * `shouldApplyStatus` is the one rule two out-of-band evidence sources share:
 * the `subagents/reconcile` snapshot and history notifications. Both are a
 * round-trip old, so both can report an active status for a run that has since
 * settled; letting either land would stick the Active-Subagents overlay and
 * the Stop control on a subagent that will never emit again.
 */

import { describe, expect, test } from "bun:test";
import type { SubagentStatus } from "@vellumai/assistant-api";

import { shouldApplyStatus } from "@/utils/subagent-status";

const ACTIVE: SubagentStatus[] = ["running", "pending", "awaiting_input"];
const TERMINAL: SubagentStatus[] = [
  "completed",
  "failed",
  "aborted",
  "interrupted",
];

describe("shouldApplyStatus", () => {
  test("an active entry accepts anything", () => {
    for (const existing of ACTIVE) {
      for (const incoming of [...ACTIVE, ...TERMINAL]) {
        expect(shouldApplyStatus(existing, incoming)).toBe(true);
      }
    }
  });

  test("a settled entry never regresses to an active status", () => {
    for (const existing of TERMINAL) {
      for (const incoming of ACTIVE) {
        expect(shouldApplyStatus(existing, incoming)).toBe(false);
      }
    }
  });

  test("a settled entry still moves between terminal states", () => {
    // A truer terminal state, `failed` over a provisional `interrupted`,
    // must still land.
    for (const existing of TERMINAL) {
      for (const incoming of TERMINAL) {
        expect(shouldApplyStatus(existing, incoming)).toBe(true);
      }
    }
  });
});
