import { describe, expect, test } from "bun:test";

import type {
  ApprovalMessageContext,
  ApprovalMessageScenario,
} from "../runtime/approval-message-composer.js";
import {
  composeApprovalMessage,
  getFallbackMessage,
} from "../runtime/approval-message-composer.js";

// ---------------------------------------------------------------------------
// Every scenario must produce a non-empty string
// ---------------------------------------------------------------------------

const ALL_SCENARIOS: ApprovalMessageScenario[] = [
  "standard_prompt",
  "guardian_prompt",
  "reminder_prompt",
  "guardian_identity_mismatch",
  "request_pending_guardian",
  "guardian_verify_failed",
  "guardian_verify_challenge_setup",
];

describe("approval-message-composer", () => {
  // -----------------------------------------------------------------------
  // Fallback messages — every scenario produces non-empty output
  // -----------------------------------------------------------------------

  describe("getFallbackMessage", () => {
    for (const scenario of ALL_SCENARIOS) {
      test(`scenario "${scenario}" produces a non-empty string`, () => {
        const msg = getFallbackMessage({ scenario });
        expect(typeof msg).toBe("string");
        expect(msg.trim().length).toBeGreaterThan(0);
      });
    }

    test("standard_prompt includes toolName when provided", () => {
      const msg = getFallbackMessage({
        scenario: "standard_prompt",
        toolName: "execute_shell",
      });
      expect(msg).toContain("execute_shell");
    });

    test("guardian_prompt includes requester identifier and toolName", () => {
      const msg = getFallbackMessage({
        scenario: "guardian_prompt",
        toolName: "write_file",
        requesterIdentifier: "alice",
      });
      expect(msg).toContain("alice");
      expect(msg).toContain("write_file");
    });

    test("guardian_verify_failed includes failureReason", () => {
      const msg = getFallbackMessage({
        scenario: "guardian_verify_failed",
        failureReason: "Code did not match.",
      });
      expect(msg).toContain("Code did not match.");
    });

    test("guardian_verify_challenge_setup includes verifyCommand in N-digit code format", () => {
      const msg = getFallbackMessage({
        scenario: "guardian_verify_challenge_setup",
        verifyCommand: "123456",
      });
      expect(msg).toContain("6-digit code: 123456");
    });
  });

  // -----------------------------------------------------------------------
  // composeApprovalMessage — layered source selection
  // -----------------------------------------------------------------------

  describe("composeApprovalMessage", () => {
    test("returns the deterministic template", () => {
      const msg = composeApprovalMessage({
        scenario: "guardian_prompt",
        toolName: "write_file",
        requesterIdentifier: "charlie",
      });
      expect(msg).toContain("charlie");
      expect(msg).toContain("write_file");
    });

    test("fallback matches getFallbackMessage output", () => {
      const ctx: ApprovalMessageContext = {
        scenario: "reminder_prompt",
      };
      expect(composeApprovalMessage(ctx)).toBe(getFallbackMessage(ctx));
    });
  });

  // -----------------------------------------------------------------------
  // Verification scenario resilience — composed messages contain key facts
  // -----------------------------------------------------------------------

  describe("verification scenario resilience", () => {
    test("guardian_verify_challenge_setup includes verify code", () => {
      const msg = composeApprovalMessage({
        scenario: "guardian_verify_challenge_setup",
        verifyCommand: "987654",
      });
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).toContain("6-digit code: 987654");
    });

    test("guardian_verify_failed includes failure reason", () => {
      const msg = composeApprovalMessage({
        scenario: "guardian_verify_failed",
        failureReason: "Too many attempts. Please try again later.",
      });
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).toContain("Too many attempts");
    });

    test("guardian_verify_failed with invalid-or-expired reason includes that reason", () => {
      const msg = composeApprovalMessage({
        scenario: "guardian_verify_failed",
        failureReason: "The verification code is invalid or has expired.",
      });
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
      expect(msg).toContain("invalid or has expired");
    });
  });
});
