import { describe, expect, test } from "bun:test";

import {
  computeProgressPercent,
  computeTier,
  PROGRESS_TARGETS,
  PROGRESS_WEIGHTS,
} from "../progress-formula.js";
import type { Capability, Fact } from "../relationship-state.js";

function fact(id: string): Fact {
  return {
    id,
    category: "world",
    text: "placeholder",
    confidence: "strong",
    source: "inferred",
  };
}

function cap(id: string, tier: Capability["tier"]): Capability {
  return {
    id,
    name: id,
    description: "",
    tier,
    gate: "",
  };
}

function facts(n: number): Fact[] {
  return Array.from({ length: n }, (_, i) => fact(`f-${i}`));
}

function unlockedCaps(n: number): Capability[] {
  return Array.from({ length: n }, (_, i) => cap(`c-${i}`, "unlocked"));
}

describe("progress-formula", () => {
  describe("PROGRESS_WEIGHTS", () => {
    test("sum to exactly 1 so a fully saturated input yields 100", () => {
      const sum =
        PROGRESS_WEIGHTS.facts +
        PROGRESS_WEIGHTS.capabilities +
        PROGRESS_WEIGHTS.conversations;
      // Use toBeCloseTo for float safety.
      expect(sum).toBeCloseTo(1, 10);
    });
  });

  describe("computeProgressPercent", () => {
    test("zero state -> 0", () => {
      expect(
        computeProgressPercent({
          facts: [],
          capabilities: [],
          conversationCount: 0,
        }),
      ).toBe(0);
    });

    test("all saturated -> 100", () => {
      expect(
        computeProgressPercent({
          facts: facts(PROGRESS_TARGETS.facts),
          capabilities: unlockedCaps(PROGRESS_TARGETS.capabilities),
          conversationCount: PROGRESS_TARGETS.conversations,
        }),
      ).toBe(100);
    });

    test("saturation clamps: inputs beyond target do not exceed 100", () => {
      expect(
        computeProgressPercent({
          facts: facts(PROGRESS_TARGETS.facts * 3),
          capabilities: unlockedCaps(PROGRESS_TARGETS.capabilities * 3),
          conversationCount: PROGRESS_TARGETS.conversations * 3,
        }),
      ).toBe(100);
    });

    test("facts-only at target contributes exactly its weight", () => {
      expect(
        computeProgressPercent({
          facts: facts(PROGRESS_TARGETS.facts),
          capabilities: [],
          conversationCount: 0,
        }),
      ).toBe(Math.round(PROGRESS_WEIGHTS.facts * 100));
    });

    test("capabilities-only at target contributes exactly its weight", () => {
      expect(
        computeProgressPercent({
          facts: [],
          capabilities: unlockedCaps(PROGRESS_TARGETS.capabilities),
          conversationCount: 0,
        }),
      ).toBe(Math.round(PROGRESS_WEIGHTS.capabilities * 100));
    });

    test("conversations-only at target contributes exactly its weight", () => {
      expect(
        computeProgressPercent({
          facts: [],
          capabilities: [],
          conversationCount: PROGRESS_TARGETS.conversations,
        }),
      ).toBe(Math.round(PROGRESS_WEIGHTS.conversations * 100));
    });

    test("non-unlocked capabilities do not contribute", () => {
      const mixed: Capability[] = [
        cap("a", "next-up"),
        cap("b", "earned"),
        cap("c", "unlocked"),
      ];
      // Only 1 of PROGRESS_TARGETS.capabilities counts toward the caps weight.
      const expected = Math.round(
        ((PROGRESS_WEIGHTS.capabilities * 1) / PROGRESS_TARGETS.capabilities) *
          100,
      );
      expect(
        computeProgressPercent({
          facts: [],
          capabilities: mixed,
          conversationCount: 0,
        }),
      ).toBe(expected);
    });

    test("specific mix: half facts, half caps, half conversations -> 50", () => {
      // Each signal at half its target contributes half its weight; total
      // is half of the combined weight (1) * 100 = 50.
      expect(
        computeProgressPercent({
          facts: facts(PROGRESS_TARGETS.facts / 2),
          capabilities: unlockedCaps(PROGRESS_TARGETS.capabilities / 2),
          conversationCount: PROGRESS_TARGETS.conversations / 2,
        }),
      ).toBe(50);
    });
  });

  describe("computeTier", () => {
    test("zero state -> tier 1 (Getting to know you)", () => {
      expect(
        computeTier({ facts: [], capabilities: [], conversationCount: 0 }),
      ).toBe(1);
    });

    test("5 conversations + 3 facts -> tier 2 (Finding my footing)", () => {
      expect(
        computeTier({
          facts: facts(3),
          capabilities: [],
          conversationCount: 5,
        }),
      ).toBe(2);
    });

    test("just below tier 2 threshold on facts -> still tier 1", () => {
      expect(
        computeTier({
          facts: facts(2),
          capabilities: [],
          conversationCount: 5,
        }),
      ).toBe(1);
    });

    test("just below tier 2 threshold on conversations -> still tier 1", () => {
      expect(
        computeTier({
          facts: facts(3),
          capabilities: [],
          conversationCount: 4,
        }),
      ).toBe(1);
    });

    test("20 conversations + 3 unlocked caps -> tier 3 (Hitting our stride)", () => {
      expect(
        computeTier({
          facts: facts(5),
          capabilities: unlockedCaps(3),
          conversationCount: 20,
        }),
      ).toBe(3);
    });

    test("20 conversations + 2 unlocked caps -> tier 2 (fallthrough)", () => {
      expect(
        computeTier({
          facts: facts(3),
          capabilities: unlockedCaps(2),
          conversationCount: 20,
        }),
      ).toBe(2);
    });

    test("tier 4 is reserved and unreachable from the default heuristic", () => {
      // Even a fully-saturated input should not produce tier 4 today.
      const result = computeTier({
        facts: facts(50),
        capabilities: unlockedCaps(6),
        conversationCount: 1_000,
      });
      expect(result).not.toBe(4);
      expect(result).toBe(3);
    });
  });
});
