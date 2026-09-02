import { describe, expect, test } from "bun:test";

import {
  applyGuardianReplyMechanics,
  buildGuardianCodeOnlyClarification,
  buildGuardianDisambiguationExample,
  buildGuardianDisambiguationLabel,
  buildGuardianInvalidActionReply,
  buildGuardianReplyDirective,
  buildGuardianRequestCodeInstruction,
  guardianCopyCarriesReplyMechanics,
  hasGuardianRequestCodeInstruction,
  parseGuardianQuestionPayload,
  parseInteractiveApprovalPayload,
  resolveGuardianInstructionModeForRequest,
  resolveGuardianInstructionModeFromFields,
  resolveGuardianQuestionInstructionMode,
  stripConflictingGuardianRequestInstructions,
  stripGuardianRequestCodeInstructions,
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
    if (!parsed || parsed.requestKind !== "pending_question") {
      return;
    }
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
    if (!parsed || parsed.requestKind !== "tool_grant_request") {
      return;
    }
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
    if (!parsed || parsed.requestKind !== "pending_question") {
      return;
    }
    expect(parsed.toolName).toBe("send_email");
  });

  test("accepts a pending_question payload without voice fields (ask_question shape)", () => {
    // callSessionId/activeGuardianRequestCount are voice-variant fields; an
    // ask_question promotion carries neither (and may carry options instead).
    const parsed = parseGuardianQuestionPayload({
      requestKind: "pending_question",
      requestId: "req-3",
      requestCode: "AAA111",
      questionText: "Which fruit?",
      options: [
        { id: "apple", label: "Apple" },
        { id: "banana", label: "Banana" },
      ],
    });
    expect(parsed).not.toBeNull();
    if (!parsed || parsed.requestKind !== "pending_question") {
      return;
    }
    expect(parsed.options?.map((o) => o.id)).toEqual(["apple", "banana"]);
  });

  test("rejects a pending_question payload missing base fields", () => {
    const parsed = parseGuardianQuestionPayload({
      requestKind: "pending_question",
      requestId: "req-3",
      // no requestCode / questionText — base-field strictness still holds
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

  test("stripGuardianRequestCodeInstructions removes both-mode directives and bare code mentions", () => {
    const text = [
      "Alice is asking to run ls /tmp.",
      "Approval code: A1B2C3",
      'Reference code: A1B2C3. Reply "A1B2C3 approve" or "A1B2C3 reject".',
      'Reply "A1B2C3 <your answer>".',
    ].join("\n");

    expect(stripGuardianRequestCodeInstructions(text, "A1B2C3")).toBe(
      "Alice is asking to run ls /tmp.",
    );
  });

  test("stripGuardianRequestCodeInstructions leaves unrelated text and other codes intact", () => {
    const text = 'Approval code: ZZZZZZ. Reply "A1B2C3 approve" if you agree.';
    expect(stripGuardianRequestCodeInstructions(text, "A1B2C3")).toBe(text);
  });

  test("parseInteractiveApprovalPayload accepts approval-mode payloads with a requestId", () => {
    expect(
      parseInteractiveApprovalPayload({
        requestKind: "tool_grant_request",
        requestId: "req-1",
        requestCode: "A1B2C3",
        questionText: "Allow host bash?",
        toolName: "host_bash",
      }),
    ).not.toBeNull();
  });

  test("guardianCopyCarriesReplyMechanics: chat channels carry them, card surfaces do not", () => {
    const approval = {
      requestId: "req-1",
      requestCode: "A1B2C3",
      requestKind: "tool_grant_request",
      questionText: "Allow bash?",
      toolName: "bash",
    };
    const question = {
      requestId: "req-2",
      requestCode: "A1B2C3",
      requestKind: "pending_question",
      questionText: "Which one?",
    };
    // The bell, the banner, and the push act through the card whatever the mode.
    expect(guardianCopyCarriesReplyMechanics("vellum", approval)).toBe(false);
    expect(guardianCopyCarriesReplyMechanics("vellum", question)).toBe(false);
    expect(guardianCopyCarriesReplyMechanics("platform", question)).toBe(false);
    // Slack draws buttons for approvals only; a question is answered by text.
    expect(guardianCopyCarriesReplyMechanics("slack", approval)).toBe(false);
    expect(guardianCopyCarriesReplyMechanics("slack", question)).toBe(true);
    expect(guardianCopyCarriesReplyMechanics("telegram", approval)).toBe(true);
    expect(guardianCopyCarriesReplyMechanics("telegram", question)).toBe(true);
  });

  test("applyGuardianReplyMechanics enforces into chat copy, strips from card-surface copy, and is idempotent", () => {
    const signal = {
      sourceEventName: "guardian.question",
      contextPayload: {
        requestId: "req-2",
        requestCode: "a1b2c3",
        requestKind: "pending_question",
        questionText: "Which one?",
      },
    } as const;
    const copy = {
      title: "Question",
      body: "Which one?\n\n1. Left\n2. Right",
      conversationSeedMessage: "Which one?\n\n1. Left\n2. Right",
    };
    const instruction = 'Reference code: A1B2C3. Reply "A1B2C3 <your answer>".';

    const telegram = applyGuardianReplyMechanics(copy, "telegram", signal);
    expect(telegram.body).toBe(`${copy.body}\n\n${instruction}`);
    expect(telegram.conversationSeedMessage).toBe(
      `${copy.body}\n\n${instruction}`,
    );
    expect(applyGuardianReplyMechanics(telegram, "telegram", signal)).toEqual(
      telegram,
    );

    const vellum = applyGuardianReplyMechanics(telegram, "vellum", signal);
    expect(vellum).toEqual(copy);
    expect(applyGuardianReplyMechanics(copy, "vellum", signal)).toEqual(copy);

    // Any other signal passes through untouched.
    expect(
      applyGuardianReplyMechanics(copy, "telegram", {
        ...signal,
        sourceEventName: "schedule.notify",
      }),
    ).toEqual(copy);
  });

  test("applyGuardianReplyMechanics replaces an instruction-only field with the question text on a card surface", () => {
    const signal = {
      sourceEventName: "guardian.question",
      contextPayload: {
        requestId: "req-3",
        requestCode: "A1B2C3",
        requestKind: "tool_grant_request",
        questionText: "Allow bash to run ls /tmp?",
        toolName: "bash",
      },
    } as const;
    const instructionOnly = {
      title: "Tool Grant Request. Approval code: A1B2C3",
      body: 'Reference code: A1B2C3. Reply "A1B2C3 approve" or "A1B2C3 reject".',
      deliveryText: "Approval code: A1B2C3",
    };
    const vellum = applyGuardianReplyMechanics(
      instructionOnly,
      "vellum",
      signal,
    );
    expect(vellum.title).toBe("Tool Grant Request.");
    expect(vellum.body).toBe("Allow bash to run ls /tmp?");
    expect(vellum.deliveryText).toBe("Allow bash to run ls /tmp?");
    // A title is a headline, so a code-only one keeps its text.
    expect(
      applyGuardianReplyMechanics(
        { ...instructionOnly, title: "Approval code: A1B2C3" },
        "vellum",
        signal,
      ).title,
    ).toBe("Approval code: A1B2C3");

    // With no question text to fall back on, the field keeps its text rather
    // than becoming empty copy the broadcaster would skip.
    const bare = applyGuardianReplyMechanics(instructionOnly, "vellum", {
      ...signal,
      contextPayload: { ...signal.contextPayload, questionText: "" },
    });
    expect(bare.body).toBe(instructionOnly.body);
  });

  test("parseInteractiveApprovalPayload rejects answer-mode and unparseable payloads", () => {
    // Answer mode: free-text questions get no Approve/Reject buttons.
    expect(
      parseInteractiveApprovalPayload({
        requestKind: "pending_question",
        requestId: "req-2",
        requestCode: "A1B2C3",
        questionText: "What time works?",
        callSessionId: "call-1",
        activeGuardianRequestCount: 1,
      }),
    ).toBeNull();

    // Answer mode without voice fields (ask_question shape): still no
    // Approve/Reject buttons — its options render via the broadcaster's
    // question-options context instead.
    expect(
      parseInteractiveApprovalPayload({
        requestKind: "pending_question",
        requestId: "req-2b",
        requestCode: "A1B2C3",
        questionText: "Which fruit?",
      }),
    ).toBeNull();

    // A pending_question carrying a toolName resolves to approval mode (a
    // guardian approval asked as a question), so it DOES render the pair —
    // mode, not voice-field presence, decides the rendering.
    expect(
      parseInteractiveApprovalPayload({
        requestKind: "pending_question",
        requestId: "req-3",
        requestCode: "A1B2C3",
        questionText: "Allow send_email?",
        toolName: "send_email",
      }),
    ).not.toBeNull();

    // Strict-parse failure: missing base fields.
    expect(
      parseInteractiveApprovalPayload({
        requestKind: "pending_question",
        requestId: "req-4",
      }),
    ).toBeNull();
  });
});
