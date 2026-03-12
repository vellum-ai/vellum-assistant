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
  "guardian_delivery_failed",
  "guardian_request_forwarded",
  "guardian_disambiguation",
  "guardian_identity_mismatch",
  "request_pending_guardian",
  "guardian_decision_outcome",
  "guardian_expired_requester",
  "guardian_expired_guardian",
  "guardian_verify_success",
  "guardian_verify_failed",
  "guardian_verify_challenge_setup",
  "guardian_verify_status_bound",
  "guardian_verify_status_unbound",
  "guardian_deny_no_identity",
  "guardian_deny_no_binding",
  "requester_cancel",
  "approval_already_resolved",
  "guardian_text_unavailable",
  "git_hooks_trust_prompt",
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

    test("guardian_delivery_failed includes toolName when provided", () => {
      const msg = getFallbackMessage({
        scenario: "guardian_delivery_failed",
        toolName: "execute_shell",
      });
      expect(msg).toContain("execute_shell");
    });

    test("guardian_request_forwarded includes toolName", () => {
      const msg = getFallbackMessage({
        scenario: "guardian_request_forwarded",
        toolName: "execute_shell",
      });
      expect(msg).toContain("execute_shell");
    });

    test("guardian_disambiguation includes pendingCount", () => {
      const msg = getFallbackMessage({
        scenario: "guardian_disambiguation",
        pendingCount: 3,
      });
      expect(msg).toContain("3");
    });

    test("guardian_decision_outcome includes decision and toolName", () => {
      const msg = getFallbackMessage({
        scenario: "guardian_decision_outcome",
        decision: "approved",
        toolName: "read_file",
      });
      expect(msg).toContain("approved");
      expect(msg).toContain("read_file");
    });

    test("guardian_expired_requester includes toolName", () => {
      const msg = getFallbackMessage({
        scenario: "guardian_expired_requester",
        toolName: "deploy",
      });
      expect(msg).toContain("deploy");
      expect(msg).toContain("expired");
    });

    test("guardian_expired_guardian includes requester and toolName", () => {
      const msg = getFallbackMessage({
        scenario: "guardian_expired_guardian",
        requesterIdentifier: "bob",
        toolName: "delete_file",
      });
      expect(msg).toContain("bob");
      expect(msg).toContain("delete_file");
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
    test("returns assistantPreface when provided (primary source)", () => {
      const preface = "The assistant already said something helpful.";
      const msg = composeApprovalMessage({
        scenario: "standard_prompt",
        toolName: "execute_shell",
        assistantPreface: preface,
      });
      expect(msg).toBe(preface);
    });

    test("ignores empty assistantPreface and falls back to template", () => {
      const msg = composeApprovalMessage({
        scenario: "standard_prompt",
        toolName: "execute_shell",
        assistantPreface: "",
      });
      expect(msg).toContain("execute_shell");
      expect(msg).not.toBe("");
    });

    test("ignores whitespace-only assistantPreface", () => {
      const msg = composeApprovalMessage({
        scenario: "standard_prompt",
        toolName: "execute_shell",
        assistantPreface: "   ",
      });
      expect(msg).toContain("execute_shell");
    });

    test("falls back to deterministic template when no assistantPreface", () => {
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

    test("guardian_verify_success produces a non-empty success message", () => {
      const msg = composeApprovalMessage({
        scenario: "guardian_verify_success",
      });
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    });

    test("guardian_verify_status_bound produces a non-empty message", () => {
      const msg = composeApprovalMessage({
        scenario: "guardian_verify_status_bound",
      });
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    });

    test("guardian_verify_status_unbound produces a non-empty message", () => {
      const msg = composeApprovalMessage({
        scenario: "guardian_verify_status_unbound",
      });
      expect(typeof msg).toBe("string");
      expect(msg.length).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Git hooks trust prompt — explicit trust decision copy
  // -----------------------------------------------------------------------

  describe("git_hooks_trust_prompt scenario", () => {
    test("produces a non-empty string", () => {
      const msg = getFallbackMessage({ scenario: "git_hooks_trust_prompt" });
      expect(typeof msg).toBe("string");
      expect(msg.trim().length).toBeGreaterThan(0);
    });

    test("mentions git hooks", () => {
      const msg = getFallbackMessage({ scenario: "git_hooks_trust_prompt" });
      expect(msg.toLowerCase()).toContain("git hooks");
    });

    test("mentions trust decision", () => {
      const msg = getFallbackMessage({ scenario: "git_hooks_trust_prompt" });
      expect(msg.toLowerCase()).toContain("trust");
    });

    test("explains default fail-closed behavior", () => {
      const msg = getFallbackMessage({ scenario: "git_hooks_trust_prompt" });
      // Should tell the user that hooks are disabled by default
      expect(msg.toLowerCase()).toContain("disabled");
    });

    test("provides clear yes/no guidance", () => {
      const msg = getFallbackMessage({ scenario: "git_hooks_trust_prompt" });
      // Should instruct user how to respond
      expect(msg.toLowerCase()).toMatch(/yes|allow|no|deny/);
    });

    test("composeApprovalMessage returns assistantPreface when provided", () => {
      const preface = "I found git hooks in this project.";
      const msg = composeApprovalMessage({
        scenario: "git_hooks_trust_prompt",
        assistantPreface: preface,
      });
      expect(msg).toBe(preface);
    });

    test("composeApprovalMessage falls back to deterministic template when no preface", () => {
      const msg = composeApprovalMessage({
        scenario: "git_hooks_trust_prompt",
      });
      expect(msg.toLowerCase()).toContain("git hooks");
    });
  });
});
