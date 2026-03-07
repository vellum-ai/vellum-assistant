import { describe, expect, test } from "bun:test";

import {
  buildGuardianCodeOnlyClarification,
  buildGuardianDisambiguationExample,
  buildGuardianDisambiguationLabel,
  buildGuardianInvalidActionReply,
  buildGuardianReplyDirective,
  buildGuardianRequestCodeInstruction,
  hasGuardianRequestCodeInstruction,
  parseGuardianQuestionPayload,
  resolveGuardianInstructionModeForRequest,
  resolveGuardianInstructionModeFromFields,
  resolveGuardianQuestionInstructionMode,
  stripConflictingGuardianRequestInstructions,
} from "../notifications/guardian-question-mode.js";

describe("guardian-question-mode", () => {
  test("parses pending_question payload as discriminated union", () => {
    const parsed = parseGuardianQuestionPayload({
      requestKind: "pending_question",
      requestId: "req-1",
      requestCode: "A1B2C3",
      questionText: "What time works?",
      callSessionId: "call-1",
      activeGuardianRequestCount: 2,
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.requestKind).toBe("pending_question");
    if (!parsed || parsed.requestKind !== "pending_question") return;
    expect(parsed.callSessionId).toBe("call-1");
    expect(parsed.activeGuardianRequestCount).toBe(2);
  });

  test("parses tool_grant_request payload and requires toolName", () => {
    const parsed = parseGuardianQuestionPayload({
      requestKind: "tool_grant_request",
      requestId: "req-2",
      requestCode: "D4E5F6",
      questionText: "Allow host bash?",
      toolName: "host_bash",
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.requestKind).toBe("tool_grant_request");
    if (!parsed || parsed.requestKind !== "tool_grant_request") return;
    expect(parsed.toolName).toBe("host_bash");
  });

  test("parses pending_question payload with optional toolName metadata", () => {
    const parsed = parseGuardianQuestionPayload({
      requestKind: "pending_question",
      requestId: "req-voice-tool-1",
      requestCode: "AA11BB",
      questionText: "Allow send_email?",
      callSessionId: "call-voice-1",
      activeGuardianRequestCount: 1,
      toolName: "send_email",
    });

    expect(parsed).not.toBeNull();
    expect(parsed?.requestKind).toBe("pending_question");
    if (!parsed || parsed.requestKind !== "pending_question") return;
    expect(parsed.toolName).toBe("send_email");
  });

  test("rejects invalid pending_question payload missing required fields", () => {
    const parsed = parseGuardianQuestionPayload({
      requestKind: "pending_question",
      requestId: "req-3",
      requestCode: "AAA111",
      questionText: "Missing call session and count",
    });
    expect(parsed).toBeNull();
  });

  test("resolve mode uses discriminant for valid typed payloads", () => {
    const resolved = resolveGuardianQuestionInstructionMode({
      requestKind: "pending_question",
      requestId: "req-1",
      requestCode: "A1B2C3",
      questionText: "What time works?",
      callSessionId: "call-1",
      activeGuardianRequestCount: 2,
    });

    expect(resolved.mode).toBe("answer");
    expect(resolved.requestKind).toBe("pending_question");
  });

  test("resolve mode defaults to approval when requestKind is missing", () => {
    const resolved = resolveGuardianQuestionInstructionMode({
      requestCode: "A1B2C3",
      questionText: "Allow host bash?",
      toolName: "host_bash",
    });

    expect(resolved.mode).toBe("approval");
    expect(resolved.requestKind).toBeNull();
  });

  test("resolve mode treats pending_question with toolName as approval-mode", () => {
    const resolved = resolveGuardianQuestionInstructionMode({
      requestKind: "pending_question",
      requestId: "req-voice-tool-2",
      requestCode: "CC22DD",
      questionText: "Allow send_email?",
      callSessionId: "call-voice-2",
      activeGuardianRequestCount: 1,
      toolName: "send_email",
    });

    expect(resolved.mode).toBe("approval");
    expect(resolved.requestKind).toBe("pending_question");
  });

  test("resolveGuardianInstructionModeFromFields returns null for unknown request kind", () => {
    const resolved = resolveGuardianInstructionModeFromFields(
      "unknown_kind",
      "send_email",
    );
    expect(resolved).toBeNull();
  });

  test("answer-mode instruction detection rejects approval phrasing", () => {
    const code = "A1B2C3";
    const wrongInstruction = buildGuardianRequestCodeInstruction(
      code,
      "approval",
    );
    const correctInstruction = buildGuardianRequestCodeInstruction(
      code,
      "answer",
    );

    expect(
      hasGuardianRequestCodeInstruction(wrongInstruction, code, "answer"),
    ).toBe(false);
    expect(
      hasGuardianRequestCodeInstruction(correctInstruction, code, "answer"),
    ).toBe(true);
  });

  test("buildGuardianReplyDirective uses mode-specific wording", () => {
    expect(buildGuardianReplyDirective("A1B2C3", "approval")).toBe(
      'Reply "A1B2C3 approve" or "A1B2C3 reject".',
    );
    expect(buildGuardianReplyDirective("A1B2C3", "answer")).toBe(
      'Reply "A1B2C3 <your answer>".',
    );
  });

  test("resolveGuardianInstructionModeForRequest handles tool-backed pending_question as approval", () => {
    expect(
      resolveGuardianInstructionModeForRequest({
        kind: "pending_question",
        toolName: "send_email",
      }),
    ).toBe("approval");
    expect(
      resolveGuardianInstructionModeForRequest({
        kind: "pending_question",
        toolName: null,
      }),
    ).toBe("answer");
  });

  test("centralized guardian response copy builders produce mode-specific copy", () => {
    expect(buildGuardianInvalidActionReply("approval", "A1B2C3")).toContain(
      "approve",
    );
    expect(buildGuardianInvalidActionReply("answer", "A1B2C3")).toContain(
      "<your answer>",
    );

    expect(
      buildGuardianCodeOnlyClarification("approval", {
        requestCode: "A1B2C3",
        questionText: "Allow send_email to bob@example.com?",
        toolName: "send_email",
      }),
    ).toContain("I found request A1B2C3 for send_email.");
    expect(
      buildGuardianCodeOnlyClarification("answer", {
        requestCode: "A1B2C3",
        questionText: "What time works best?",
      }),
    ).toContain("I found question A1B2C3.");

    expect(
      buildGuardianDisambiguationLabel("approval", {
        questionText: "Allow send_email to bob@example.com?",
        toolName: "send_email",
      }),
    ).toBe("send_email");
    expect(
      buildGuardianDisambiguationLabel("answer", {
        questionText: "What time works best?",
      }),
    ).toBe("What time works best?");

    expect(buildGuardianDisambiguationExample("approval", "A1B2C3")).toBe(
      'For approvals: reply "A1B2C3 approve" or "A1B2C3 reject".',
    );
    expect(buildGuardianDisambiguationExample("answer", "A1B2C3")).toBe(
      'For questions: reply "A1B2C3 <your answer>".',
    );
  });

  test("stripConflictingGuardianRequestInstructions removes opposite-mode instructions", () => {
    const approvalText =
      'Reference code: A1B2C3. Reply "A1B2C3 approve" or "A1B2C3 reject".';
    const answerText = 'Reference code: A1B2C3. Reply "A1B2C3 <your answer>".';

    expect(
      stripConflictingGuardianRequestInstructions(
        approvalText,
        "A1B2C3",
        "answer",
      ),
    ).toBe("");
    expect(
      stripConflictingGuardianRequestInstructions(
        answerText,
        "A1B2C3",
        "approval",
      ),
    ).toBe("");
  });
});
