import { describe, expect, test } from "bun:test";

import {
  type Capability,
  DEFAULT_CAPABILITIES,
  type Fact,
  RELATIONSHIP_STATE_VERSION,
  type RelationshipState,
  type RelationshipTier,
  TIER_INFO,
} from "../home/relationship-state.js";

describe("relationship state contract", () => {
  describe("RelationshipState JSON round-trip", () => {
    test("round-trips through JSON.stringify / JSON.parse with structural equality", () => {
      const facts: Fact[] = [
        {
          id: "fact-1",
          category: "voice",
          text: "Prefers concise, lowercase replies.",
          confidence: "strong",
          source: "onboarding",
        },
        {
          id: "fact-2",
          category: "world",
          text: "Lives in Brooklyn.",
          confidence: "uncertain",
          source: "inferred",
        },
        {
          id: "fact-3",
          category: "priorities",
          text: "Ships JARVIS milestones on Fridays.",
          confidence: "strong",
          source: "inferred",
        },
      ];

      const capabilities: Capability[] = [
        {
          id: "email",
          name: "Email access",
          description: "Read, draft, and manage your email",
          tier: "next-up",
          gate: "Connect Google or Outlook",
          ctaLabel: "Connect Google →",
        },
        {
          id: "voice-writing",
          name: "Write in your voice",
          description: "Draft messages and docs that sound like you",
          tier: "earned",
          gate: "Usage — needs conversation history",
          unlockHint: "I need to learn how you communicate first",
        },
        {
          id: "calendar",
          name: "Calendar awareness",
          description: "Know your schedule, prep for meetings",
          tier: "unlocked",
          gate: "Connect calendar",
        },
      ];

      const original: RelationshipState = {
        version: RELATIONSHIP_STATE_VERSION,
        assistantId: "self",
        tier: 2,
        progressPercent: 42,
        facts,
        capabilities,
        conversationCount: 17,
        hatchedDate: "2026-04-01T00:00:00.000Z",
        assistantName: "Nova",
        userName: "Alex",
        updatedAt: "2026-04-13T12:34:56.000Z",
      };

      const serialized = JSON.stringify(original);
      const parsed = JSON.parse(serialized) as RelationshipState;

      expect(parsed).toEqual(original);
      // Re-serialize and compare strings to guarantee no hidden fields leak
      // and field order is stable given the source object.
      expect(JSON.stringify(parsed)).toBe(serialized);
    });

    test("round-trips with userName omitted", () => {
      const original: RelationshipState = {
        version: RELATIONSHIP_STATE_VERSION,
        assistantId: "self",
        tier: 1,
        progressPercent: 0,
        facts: [],
        capabilities: [],
        conversationCount: 0,
        hatchedDate: "2026-04-13T00:00:00.000Z",
        assistantName: "Nova",
        updatedAt: "2026-04-13T00:00:00.000Z",
      };

      const parsed = JSON.parse(JSON.stringify(original)) as RelationshipState;
      expect(parsed).toEqual(original);
      expect(parsed.userName).toBeUndefined();
    });
  });

  describe("DEFAULT_CAPABILITIES", () => {
    test("contains the exact six capability ids in the required order", () => {
      const ids = DEFAULT_CAPABILITIES.map((c) => c.id);
      expect(ids).toEqual([
        "email",
        "calendar",
        "slack",
        "voice-writing",
        "proactive",
        "autonomous",
      ]);
    });

    test("each default capability has a non-empty name, description, and gate", () => {
      for (const cap of DEFAULT_CAPABILITIES) {
        expect(cap.name.length).toBeGreaterThan(0);
        expect(cap.description.length).toBeGreaterThan(0);
        expect(cap.gate.length).toBeGreaterThan(0);
      }
    });

    test("connector capabilities have a ctaLabel, learned capabilities have an unlockHint", () => {
      const byId = Object.fromEntries(
        DEFAULT_CAPABILITIES.map((c) => [c.id, c]),
      );

      for (const id of ["email", "calendar", "slack"] as const) {
        expect(byId[id]?.ctaLabel?.length ?? 0).toBeGreaterThan(0);
      }

      for (const id of ["voice-writing", "proactive", "autonomous"] as const) {
        expect(byId[id]?.unlockHint?.length ?? 0).toBeGreaterThan(0);
      }
    });

    test("default capabilities omit the tier field (tier is computed at write time)", () => {
      for (const cap of DEFAULT_CAPABILITIES) {
        expect((cap as Record<string, unknown>).tier).toBeUndefined();
      }
    });
  });

  describe("TIER_INFO", () => {
    test("defines all four tiers with non-empty label and description", () => {
      const tiers: RelationshipTier[] = [1, 2, 3, 4];
      for (const tier of tiers) {
        const info = TIER_INFO[tier];
        expect(info).toBeDefined();
        expect(info.label.length).toBeGreaterThan(0);
        expect(info.description.length).toBeGreaterThan(0);
      }
    });

    test("tiers 1-3 have a nextTierHint, tier 4 does not", () => {
      expect(TIER_INFO[1].nextTierHint?.length ?? 0).toBeGreaterThan(0);
      expect(TIER_INFO[2].nextTierHint?.length ?? 0).toBeGreaterThan(0);
      expect(TIER_INFO[3].nextTierHint?.length ?? 0).toBeGreaterThan(0);
      expect(TIER_INFO[4].nextTierHint).toBeUndefined();
    });
  });

  describe("RELATIONSHIP_STATE_VERSION", () => {
    test("is pinned to 1 (bumping requires an explicit migration PR)", () => {
      expect(RELATIONSHIP_STATE_VERSION).toBe(1);
    });
  });
});
