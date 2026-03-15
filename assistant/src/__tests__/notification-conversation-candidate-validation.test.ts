/**
 * Focused tests for conversation candidate validation in the notification decision
 * engine. Validates that:
 * - Valid reuse targets pass validation
 * - Invalid reuse targets are rejected and downgraded to start_new
 * - Candidate context is structurally correct and auditable
 */

import { describe, expect, test } from "bun:test";

import type {
  ConversationCandidate,
  ConversationCandidateSet,
} from "../notifications/conversation-candidates.js";
import { validateConversationActions } from "../notifications/decision-engine.js";
import type {
  ConversationAction,
  NotificationChannel,
} from "../notifications/types.js";

// -- Helpers -----------------------------------------------------------------

function makeCandidate(
  overrides?: Partial<ConversationCandidate>,
): ConversationCandidate {
  return {
    conversationId: "conv-default",
    title: "Test Thread",
    updatedAt: Date.now(),
    latestSourceEventName: "test.event",
    channel: "vellum" as NotificationChannel,
    ...overrides,
  };
}

/**
 * Simple candidate ID check equivalent to the removed isValidCandidateId.
 * Used in tests to verify candidate matching semantics.
 */
function isCandidateIdPresent(
  id: string,
  candidates: ConversationCandidate[],
): boolean {
  return candidates.some((c) => c.conversationId === id);
}

// -- Tests -------------------------------------------------------------------

describe("conversation candidate validation", () => {
  describe("candidate ID matching", () => {
    test("returns true when conversationId matches a candidate", () => {
      const candidates = [
        makeCandidate({ conversationId: "conv-001" }),
        makeCandidate({ conversationId: "conv-002" }),
      ];

      expect(isCandidateIdPresent("conv-001", candidates)).toBe(true);
      expect(isCandidateIdPresent("conv-002", candidates)).toBe(true);
    });

    test("returns false when conversationId does not match any candidate", () => {
      const candidates = [makeCandidate({ conversationId: "conv-001" })];

      expect(isCandidateIdPresent("conv-999", candidates)).toBe(false);
    });

    test("returns false for empty candidate list", () => {
      expect(isCandidateIdPresent("conv-001", [])).toBe(false);
    });

    test("returns false for empty string conversationId", () => {
      const candidates = [makeCandidate({ conversationId: "conv-001" })];

      expect(isCandidateIdPresent("", candidates)).toBe(false);
    });

    test("matching is exact (no substring or prefix matching)", () => {
      const candidates = [makeCandidate({ conversationId: "conv-001" })];

      expect(isCandidateIdPresent("conv-00", candidates)).toBe(false);
      expect(isCandidateIdPresent("conv-0011", candidates)).toBe(false);
      expect(isCandidateIdPresent("CONV-001", candidates)).toBe(false);
    });
  });

  describe("candidate metadata structure", () => {
    test("candidate without guardian context has no optional fields", () => {
      const candidate = makeCandidate();

      expect(candidate.guardianContext).toBeUndefined();
    });

    test("candidate with guardian context includes pending counts", () => {
      const candidate = makeCandidate({
        guardianContext: { pendingUnresolvedRequestCount: 3 },
      });

      expect(candidate.guardianContext?.pendingUnresolvedRequestCount).toBe(3);
    });

    test("candidate with null title is valid", () => {
      const candidate = makeCandidate({ title: null });
      expect(candidate.title).toBeNull();
    });

    test("candidate with null latestSourceEventName is valid", () => {
      const candidate = makeCandidate({ latestSourceEventName: null });
      expect(candidate.latestSourceEventName).toBeNull();
    });
  });

  describe("conversation action downgrade semantics", () => {
    test("start_new action does not require a conversationId", () => {
      const action: ConversationAction = { action: "start_new" };
      expect(action.action).toBe("start_new");
      expect("conversationId" in action).toBe(false);
    });

    test("reuse_existing with valid candidate is accepted via validateConversationActions", () => {
      const candidateSet: ConversationCandidateSet = {
        vellum: [makeCandidate({ conversationId: "conv-valid" })],
      };

      const result = validateConversationActions(
        { vellum: { action: "reuse_existing", conversationId: "conv-valid" } },
        ["vellum"] as NotificationChannel[],
        candidateSet,
      );

      expect(result.vellum?.action).toBe("reuse_existing");
      if (result.vellum?.action === "reuse_existing") {
        expect(result.vellum.conversationId).toBe("conv-valid");
      }
    });

    test("reuse_existing with invalid candidate is downgraded to start_new", () => {
      const candidateSet: ConversationCandidateSet = {
        vellum: [makeCandidate({ conversationId: "conv-valid" })],
      };

      const result = validateConversationActions(
        { vellum: { action: "reuse_existing", conversationId: "conv-hacked" } },
        ["vellum"] as NotificationChannel[],
        candidateSet,
      );

      expect(result.vellum?.action).toBe("start_new");
    });

    test("reuse_existing with empty candidate set is downgraded to start_new", () => {
      const result = validateConversationActions(
        { vellum: { action: "reuse_existing", conversationId: "conv-any" } },
        ["vellum"] as NotificationChannel[],
        undefined,
      );

      expect(result.vellum?.action).toBe("start_new");
    });
  });

  describe("candidate set per channel", () => {
    test("channels without candidates result in empty map entries", () => {
      const candidateMap: ConversationCandidateSet = {};

      // When no candidates exist for vellum, the map has no entry
      expect(candidateMap.vellum).toBeUndefined();
    });

    test("candidate set preserves channel association via validateConversationActions", () => {
      const vellumCandidates = [
        makeCandidate({
          conversationId: "conv-v1",
          channel: "vellum" as NotificationChannel,
        }),
      ];
      const telegramCandidates = [
        makeCandidate({
          conversationId: "conv-t1",
          channel: "telegram" as NotificationChannel,
        }),
      ];

      const candidateSet: ConversationCandidateSet = {
        vellum: vellumCandidates,
        telegram: telegramCandidates,
      };

      // Vellum candidate should not be valid for telegram and vice versa
      const validChannels: NotificationChannel[] = ["vellum", "telegram"];

      const result1 = validateConversationActions(
        { vellum: { action: "reuse_existing", conversationId: "conv-v1" } },
        validChannels,
        candidateSet,
      );
      expect(result1.vellum?.action).toBe("reuse_existing");

      const result2 = validateConversationActions(
        { vellum: { action: "reuse_existing", conversationId: "conv-t1" } },
        validChannels,
        candidateSet,
      );
      expect(result2.vellum?.action).toBe("start_new");

      const result3 = validateConversationActions(
        { telegram: { action: "reuse_existing", conversationId: "conv-t1" } },
        validChannels,
        candidateSet,
      );
      expect(result3.telegram?.action).toBe("reuse_existing");

      const result4 = validateConversationActions(
        { telegram: { action: "reuse_existing", conversationId: "conv-v1" } },
        validChannels,
        candidateSet,
      );
      expect(result4.telegram?.action).toBe("start_new");
    });
  });
});
