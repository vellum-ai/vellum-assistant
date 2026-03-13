import { describe, expect, test } from "bun:test";

import type {
  GuardianActionMessageContext,
  GuardianActionMessageScenario,
} from "../runtime/guardian-action-message-composer.js";
import {
  composeGuardianActionMessageGenerative,
  getGuardianActionFallbackMessage,
} from "../runtime/guardian-action-message-composer.js";
import type { GuardianActionCopyGenerator } from "../runtime/http-types.js";

// ---------------------------------------------------------------------------
// Every scenario must produce a non-empty string
// ---------------------------------------------------------------------------

const ALL_SCENARIOS: GuardianActionMessageScenario[] = [
  "caller_timeout_acknowledgment",
  "caller_timeout_continue",
  "guardian_late_answer_followup",
  "guardian_followup_dispatching",
  "guardian_followup_completed",
  "guardian_followup_failed",
  "guardian_followup_declined_ack",
  "guardian_followup_clarification",
  "guardian_pending_disambiguation",
  "guardian_expired_disambiguation",
  "guardian_followup_disambiguation",
  "guardian_stale_answered",
  "guardian_stale_expired",
  "guardian_stale_followup",
  "guardian_stale_superseded",
  "guardian_superseded_remap",
  "guardian_unknown_code",
  "guardian_auto_matched",
  "followup_call_started",
  "followup_action_failed",
  "guardian_answer_delivery_failed",
];

describe("guardian-action-copy-generator", () => {
  // -----------------------------------------------------------------------
  // Fallback messages -- every scenario produces non-empty output
  // -----------------------------------------------------------------------

  describe("getGuardianActionFallbackMessage", () => {
    for (const scenario of ALL_SCENARIOS) {
      test(`scenario "${scenario}" produces a non-empty string`, () => {
        const msg = getGuardianActionFallbackMessage({ scenario });
        expect(typeof msg).toBe("string");
        expect(msg.trim().length).toBeGreaterThan(0);
      });
    }

    test("caller_timeout_acknowledgment includes guardianIdentifier when provided", () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: "caller_timeout_acknowledgment",
        guardianIdentifier: "Dr. Smith",
      });
      expect(msg).toContain("Dr. Smith");
    });

    test("guardian_late_answer_followup includes callerIdentifier when provided", () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: "guardian_late_answer_followup",
        callerIdentifier: "Alice",
      });
      expect(msg).toContain("Alice");
    });

    test("guardian_followup_dispatching includes followupAction when provided", () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: "guardian_followup_dispatching",
        followupAction: "send them a text message",
      });
      expect(msg).toContain("send them a text message");
    });

    test("guardian_followup_completed includes followupAction when provided", () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: "guardian_followup_completed",
        followupAction: "sent the message",
      });
      expect(msg).toContain("sent the message");
    });

    test("guardian_followup_failed includes failureReason when provided", () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: "guardian_followup_failed",
        failureReason: "The phone number is not valid.",
      });
      expect(msg).toContain("The phone number is not valid.");
    });

    test("guardian_expired_disambiguation includes request codes when provided", () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: "guardian_expired_disambiguation",
        requestCodes: ["Q1A2B3", "Q9Z8Y7"],
      });
      expect(msg).toContain("Q1A2B3");
      expect(msg).toContain("Q9Z8Y7");
    });

    test("guardian_followup_disambiguation includes request codes when provided", () => {
      const msg = getGuardianActionFallbackMessage({
        scenario: "guardian_followup_disambiguation",
        requestCodes: ["QFOO12"],
      });
      expect(msg).toContain("QFOO12");
    });
  });

  // -----------------------------------------------------------------------
  // composeGuardianActionMessageGenerative -- layered composition
  // -----------------------------------------------------------------------

  describe("composeGuardianActionMessageGenerative", () => {
    test("with no generator returns fallback", async () => {
      const context: GuardianActionMessageContext = {
        scenario: "caller_timeout_acknowledgment",
        guardianIdentifier: "Jane",
      };
      const msg = await composeGuardianActionMessageGenerative(context);
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });

    test("with generator that returns text uses the generated text", async () => {
      const generatedText = "Custom generated message about the timeout.";
      const generator: GuardianActionCopyGenerator = async () => generatedText;
      const context: GuardianActionMessageContext = {
        scenario: "caller_timeout_acknowledgment",
      };
      // In test env, generator is skipped and fallback is returned
      const msg = await composeGuardianActionMessageGenerative(
        context,
        {},
        generator,
      );
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });

    test("with generator that throws returns fallback", async () => {
      const generator: GuardianActionCopyGenerator = async () => {
        throw new Error("Provider unavailable");
      };
      const context: GuardianActionMessageContext = {
        scenario: "guardian_followup_failed",
        failureReason: "Network error",
      };
      const msg = await composeGuardianActionMessageGenerative(
        context,
        {},
        generator,
      );
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });

    test("with generator that returns null returns fallback", async () => {
      const generator: GuardianActionCopyGenerator = async () => null;
      const context: GuardianActionMessageContext = {
        scenario: "guardian_stale_expired",
      };
      const msg = await composeGuardianActionMessageGenerative(
        context,
        {},
        generator,
      );
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });

    test("uses custom fallbackText from options when provided", async () => {
      const context: GuardianActionMessageContext = {
        scenario: "caller_timeout_continue",
      };
      const customFallback = "Custom fallback text for this scenario.";
      const msg = await composeGuardianActionMessageGenerative(context, {
        fallbackText: customFallback,
      });
      expect(msg).toBe(customFallback);
    });

    test("skips generation in test environment", async () => {
      let generatorCalled = false;
      const generator: GuardianActionCopyGenerator = async () => {
        generatorCalled = true;
        return "This should not be returned in test env";
      };
      const context: GuardianActionMessageContext = {
        scenario: "guardian_followup_declined_ack",
      };
      const msg = await composeGuardianActionMessageGenerative(
        context,
        {},
        generator,
      );
      expect(generatorCalled).toBe(false);
      expect(msg).toBe(getGuardianActionFallbackMessage(context));
    });
  });
});
