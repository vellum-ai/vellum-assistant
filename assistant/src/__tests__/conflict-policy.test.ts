import { describe, expect, test } from "bun:test";

import {
  isConflictKindEligible,
  isConflictKindPairEligible,
  isConflictUserEvidenced,
  isDurableInstructionStatement,
  isStatementConflictEligible,
  isTransientTrackingStatement,
  isUserEvidencedVerificationState,
} from "../memory/conflict-policy.js";

describe("conflict-policy", () => {
  const config = { conflictableKinds: ["preference", "profile", "constraint"] };

  describe("isConflictKindEligible", () => {
    test("returns true for eligible kind", () => {
      expect(isConflictKindEligible("preference", config)).toBe(true);
      expect(isConflictKindEligible("profile", config)).toBe(true);
      expect(isConflictKindEligible("constraint", config)).toBe(true);
    });

    test("returns false for ineligible kind", () => {
      expect(isConflictKindEligible("project", config)).toBe(false);
      expect(isConflictKindEligible("todo", config)).toBe(false);
      expect(isConflictKindEligible("fact", config)).toBe(false);
    });
  });

  describe("isConflictKindPairEligible", () => {
    test("returns true when both kinds are eligible", () => {
      expect(isConflictKindPairEligible("preference", "profile", config)).toBe(
        true,
      );
    });

    test("returns false when existing kind is ineligible", () => {
      expect(isConflictKindPairEligible("project", "preference", config)).toBe(
        false,
      );
    });

    test("returns false when candidate kind is ineligible", () => {
      expect(isConflictKindPairEligible("preference", "todo", config)).toBe(
        false,
      );
    });

    test("returns false when both kinds are ineligible", () => {
      expect(isConflictKindPairEligible("project", "todo", config)).toBe(false);
    });
  });

  describe("isTransientTrackingStatement", () => {
    test("detects PR URLs", () => {
      expect(
        isTransientTrackingStatement(
          "Track https://github.com/org/repo/pull/5526",
        ),
      ).toBe(true);
    });

    test("detects issue/ticket references", () => {
      expect(isTransientTrackingStatement("Track PR #5526 and #5525")).toBe(
        true,
      );
      expect(isTransientTrackingStatement("See issue #42 for details")).toBe(
        true,
      );
      expect(isTransientTrackingStatement("Filed ticket 1234")).toBe(true);
    });

    test("detects tracking language", () => {
      expect(isTransientTrackingStatement("While we wait for CI to pass")).toBe(
        true,
      );
      expect(isTransientTrackingStatement("This PR needs review")).toBe(true);
    });

    test("does not flag generic time words as transient", () => {
      expect(isTransientTrackingStatement("The deadline is today")).toBe(false);
      expect(isTransientTrackingStatement("I need this right now")).toBe(false);
    });

    test("does not flag durable statements", () => {
      expect(
        isTransientTrackingStatement(
          "Always answer with concise bullet points",
        ),
      ).toBe(false);
      expect(isTransientTrackingStatement("User prefers dark mode")).toBe(
        false,
      );
    });

    test("does not false-positive on non-PR URLs", () => {
      expect(
        isTransientTrackingStatement("Visit https://example.com for docs"),
      ).toBe(false);
    });
  });

  describe("isDurableInstructionStatement", () => {
    test("detects durable instruction cues", () => {
      expect(
        isDurableInstructionStatement(
          "Always answer with concise bullet points",
        ),
      ).toBe(true);
      expect(
        isDurableInstructionStatement("Never use semicolons in JavaScript"),
      ).toBe(true);
      expect(
        isDurableInstructionStatement("Use concise format for status updates"),
      ).toBe(true);
      expect(
        isDurableInstructionStatement("The default database is Postgres"),
      ).toBe(true);
    });

    test("rejects statements without durable cues", () => {
      expect(isDurableInstructionStatement("Check the build output")).toBe(
        false,
      );
      expect(isDurableInstructionStatement("Run the migration script")).toBe(
        false,
      );
    });
  });

  describe("isStatementConflictEligible", () => {
    test("rejects transient statements for any kind", () => {
      expect(isStatementConflictEligible("preference", "Track PR #5526")).toBe(
        false,
      );
      expect(
        isStatementConflictEligible("instruction", "This PR needs review"),
      ).toBe(false);
    });

    test("accepts durable instruction statements", () => {
      expect(
        isStatementConflictEligible(
          "instruction",
          "Always use TypeScript strict mode",
        ),
      ).toBe(true);
      expect(
        isStatementConflictEligible("style", "Default to concise format"),
      ).toBe(true);
    });

    test("rejects non-durable instruction statements", () => {
      expect(
        isStatementConflictEligible("instruction", "Run the build first"),
      ).toBe(false);
      expect(isStatementConflictEligible("style", "Check the output")).toBe(
        false,
      );
    });

    test("accepts non-transient statements for non-instruction kinds", () => {
      expect(
        isStatementConflictEligible("preference", "User prefers dark mode"),
      ).toBe(true);
      expect(
        isStatementConflictEligible("fact", "User works at Acme Corp"),
      ).toBe(true);
    });

    test("rejects kinds not in conflictableKinds when config is provided", () => {
      const policyConfig = { conflictableKinds: ["preference", "profile"] };
      expect(
        isStatementConflictEligible(
          "fact",
          "User works at Acme Corp",
          policyConfig,
        ),
      ).toBe(false);
      expect(
        isStatementConflictEligible(
          "preference",
          "User prefers dark mode",
          policyConfig,
        ),
      ).toBe(true);
    });

    test("skips kind check when config is omitted", () => {
      expect(
        isStatementConflictEligible("fact", "User works at Acme Corp"),
      ).toBe(true);
    });
  });

  describe("isUserEvidencedVerificationState", () => {
    test("accepts user_reported", () => {
      expect(isUserEvidencedVerificationState("user_reported")).toBe(true);
    });

    test("accepts user_confirmed", () => {
      expect(isUserEvidencedVerificationState("user_confirmed")).toBe(true);
    });

    test("accepts legacy_import", () => {
      expect(isUserEvidencedVerificationState("legacy_import")).toBe(true);
    });

    test("rejects assistant_inferred", () => {
      expect(isUserEvidencedVerificationState("assistant_inferred")).toBe(
        false,
      );
    });

    test("rejects unknown states", () => {
      expect(isUserEvidencedVerificationState("")).toBe(false);
      expect(isUserEvidencedVerificationState("auto_detected")).toBe(false);
      expect(isUserEvidencedVerificationState("pending")).toBe(false);
    });
  });

  describe("isConflictUserEvidenced", () => {
    test("returns true when existing side is user-evidenced", () => {
      expect(
        isConflictUserEvidenced("user_reported", "assistant_inferred"),
      ).toBe(true);
      expect(
        isConflictUserEvidenced("user_confirmed", "assistant_inferred"),
      ).toBe(true);
      expect(
        isConflictUserEvidenced("legacy_import", "assistant_inferred"),
      ).toBe(true);
    });

    test("returns true when candidate side is user-evidenced", () => {
      expect(
        isConflictUserEvidenced("assistant_inferred", "user_reported"),
      ).toBe(true);
      expect(
        isConflictUserEvidenced("assistant_inferred", "user_confirmed"),
      ).toBe(true);
      expect(
        isConflictUserEvidenced("assistant_inferred", "legacy_import"),
      ).toBe(true);
    });

    test("returns true when both sides are user-evidenced", () => {
      expect(isConflictUserEvidenced("user_reported", "user_confirmed")).toBe(
        true,
      );
      expect(isConflictUserEvidenced("legacy_import", "user_reported")).toBe(
        true,
      );
    });

    test("returns false when neither side is user-evidenced", () => {
      expect(
        isConflictUserEvidenced("assistant_inferred", "assistant_inferred"),
      ).toBe(false);
    });

    test("returns false for unknown states on both sides", () => {
      expect(isConflictUserEvidenced("auto_detected", "pending")).toBe(false);
      expect(
        isConflictUserEvidenced("assistant_inferred", "auto_detected"),
      ).toBe(false);
    });
  });
});
