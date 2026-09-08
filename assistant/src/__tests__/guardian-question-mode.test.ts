import { describe, expect, test } from "bun:test";

import {
  buildGuardianCodeOnlyClarification,
  buildGuardianDisambiguationExample,
  buildGuardianDisambiguationLabel,
  buildGuardianInvalidActionReply,
  buildGuardianReplyDirective,
  buildQuestionDeliveryText,
  parseGuardianQuestionPayload,
  parseInteractiveApprovalPayload,
  resolveGuardianInstructionModeForRequest,
  resolveGuardianInstructionModeFromFields,
  resolveGuardianQuestionInstructionMode,
  stripGuardianReplyMechanicsFromCopy,
} from "../notifications/guardian-question-mode.js";
import { stripRequestCodeDirectives } from "../notifications/notification-utils.js";

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

  test("stripRequestCodeDirectives removes both-mode directives and bare code mentions", () => {
    const text = [
      "Alice is asking to run ls /tmp.",
      "Approval code: A1B2C3",
      'Reference code: A1B2C3. Reply "A1B2C3 approve" or "A1B2C3 reject".',
      'Reply "A1B2C3 <your answer>".',
    ].join("\n");

    expect(stripRequestCodeDirectives(text, "A1B2C3")).toBe(
      "Alice is asking to run ls /tmp.",
    );
  });

  test("stripRequestCodeDirectives leaves other codes intact and strips a paraphrased directive for ours", () => {
    const text = 'Approval code: ZZZZZZ. Reply "A1B2C3 approve" if you agree.';
    expect(stripRequestCodeDirectives(text, "A1B2C3")).toBe(
      "Approval code: ZZZZZZ.",
    );
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

  test("buildQuestionDeliveryText numbers the options and carries no code", () => {
    expect(
      buildQuestionDeliveryText({
        questionText: "Which one?",
        options: [{ label: "Left" }, { label: "Right" }],
      }),
    ).toBe("Which one?\n\n1. Left\n2. Right");
    expect(buildQuestionDeliveryText({ questionText: "Which one?" })).toBe(
      "Which one?",
    );
  });

  test("stripGuardianReplyMechanicsFromCopy removes either mode's instruction and bare code mentions", () => {
    const copy = {
      title: "Tool Grant Request",
      body: 'Allow bash?\n\nReference code: A1B2C3. Reply "A1B2C3 approve" or "A1B2C3 reject".',
      deliveryText: 'Allow bash? Reply "A1B2C3 <your answer>".',
      conversationSeedMessage: "Allow bash?\n\nApproval code: A1B2C3.",
    };
    const stripped = stripGuardianReplyMechanicsFromCopy(
      copy,
      "A1B2C3",
      "Allow bash to run ls /tmp?",
    );
    expect(stripped.title).toBe("Tool Grant Request");
    expect(stripped.body).toBe("Allow bash?");
    expect(stripped.deliveryText).toBe("Allow bash?");
    expect(stripped.conversationSeedMessage).toBe("Allow bash?");
    // Idempotent: clean copy passes through unchanged.
    expect(
      stripGuardianReplyMechanicsFromCopy(stripped, "A1B2C3", "x"),
    ).toEqual(stripped);
  });

  test("stripGuardianReplyMechanicsFromCopy replaces an instruction-only field with the question and a code-only title with the headline", () => {
    const instructionOnly = {
      title: "Tool Grant Request. Approval code: A1B2C3",
      body: 'Reference code: A1B2C3. Reply "A1B2C3 approve" or "A1B2C3 reject".',
      deliveryText: "Approval code: A1B2C3",
    };
    const stripped = stripGuardianReplyMechanicsFromCopy(
      instructionOnly,
      "A1B2C3",
      "Allow bash to run ls /tmp?",
    );
    expect(stripped.title).toBe("Tool Grant Request.");
    expect(stripped.body).toBe("Allow bash to run ls /tmp?");
    expect(stripped.deliveryText).toBe("Allow bash to run ls /tmp?");
    // A title is a headline, so a code-only one keeps its text; a body with
    // no question to fall back on keeps its text rather than going empty.
    // A title is a headline, so a mechanics-only one becomes the kind's
    // deterministic title; a body with no question to fall back on keeps
    // its text rather than going empty.
    for (const ask of [undefined, ""]) {
      const bare = stripGuardianReplyMechanicsFromCopy(
        { ...instructionOnly, title: "Approval code: A1B2C3" },
        "A1B2C3",
        ask,
      );
      expect(bare.title).toBe("Guardian Question");
      expect(bare.body).toBe(instructionOnly.body);
    }
  });

  test("stripRequestCodeDirectives matches the code and verb whatever the quoting", () => {
    for (const body of [
      "Allow bash? Reply `A1B2C3 approve` to allow it.",
      "Allow bash? Reply \u201cA1B2C3 approve\u201d to allow it.",
      "Allow bash? Reply A1B2C3 approve to allow it.",
      "Allow bash? Reply 'A1B2C3 <your answer>' when ready.",
    ]) {
      expect(stripRequestCodeDirectives(body, "A1B2C3")).toBe("Allow bash?");
    }
    // The code alone, or beside a word that is not a reply verb, is content.
    expect(
      stripRequestCodeDirectives(
        "Ticket A1B2C3 approves the budget.",
        "A1B2C3",
      ),
    ).toBe("Ticket A1B2C3 approves the budget.");
  });

  test("stripRequestCodeDirectives removes paraphrased and negated directives as whole sentences", () => {
    expect(
      stripRequestCodeDirectives(
        'Allow bash? Reply "A1B2C3 approve" to allow it, or do not reply "A1B2C3 reject". Thanks.',
        "A1B2C3",
      ),
    ).toBe("Allow bash? Thanks.");
    expect(
      stripRequestCodeDirectives(
        "Use reference code A1B2C3 for this request.\nThe code ZZ9999 is a ticket.",
        "A1B2C3",
      ),
    ).toBe("The code ZZ9999 is a ticket.");
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
