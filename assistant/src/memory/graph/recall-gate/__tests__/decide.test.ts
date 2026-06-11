import { describe, expect, test } from "bun:test";

import type { ContentBlock } from "../../../../providers/types.js";
import { evaluateRecallGate } from "../decide.js";

function makeMessages(
  ...pairs: Array<{ role: string; text: string }>
): Array<{ role: string; content: ContentBlock[] }> {
  return pairs.map((p) => ({
    role: p.role,
    content: [{ type: "text" as const, text: p.text }],
  }));
}

describe("evaluateRecallGate", () => {
  test("default decision is retrieve when no rule fires", () => {
    const messages = makeMessages({
      role: "user",
      text: "Tell me about the memory architecture in detail",
    });
    const d = evaluateRecallGate(
      "Tell me about the memory architecture in detail",
      "",
      messages,
      3,
    );
    expect(d.skip).toBe(false);
    expect(d.rule).toBeNull();
  });

  test("rule 1 — empty text → skip", () => {
    const messages = makeMessages({ role: "user", text: "" });
    const d = evaluateRecallGate("", "", messages, 2);
    expect(d.skip).toBe(true);
    expect(d.rule).toBe("tool-result-only");
  });

  test("rule 2 — first turn, short, no entities → skip", () => {
    const messages = makeMessages({ role: "user", text: "hey" });
    const d = evaluateRecallGate("hey", "", messages, 1);
    expect(d.skip).toBe(true);
    expect(d.rule).toBe("first-turn-one-shot");
  });

  test("rule 3 — meta-query → skip", () => {
    const messages = makeMessages({ role: "user", text: "/help" });
    const d = evaluateRecallGate("/help", "", messages, 5);
    expect(d.skip).toBe(true);
    expect(d.rule).toBe("meta-query");
  });

  test("rule 5 — small-talk → skip", () => {
    const messages = makeMessages(
      { role: "user", text: "hello world" },
      { role: "assistant", text: "how can I help you?" },
      { role: "user", text: "thanks" },
    );
    const d = evaluateRecallGate("thanks", "how can I help you?", messages, 2);
    expect(d.skip).toBe(true);
    expect(d.rule).toBe("small-talk");
  });

  test("first-match ordering — rule 1 fires before rule 5", () => {
    const messages = makeMessages({ role: "user", text: "" });
    const d = evaluateRecallGate("", "", messages, 1);
    expect(d.rule).toBe("tool-result-only");
  });

  test("safety floor overrides skip when salient token in context", () => {
    const messages = makeMessages(
      { role: "user", text: "Check Devin status" },
      { role: "assistant", text: "Devin is running fine" },
      { role: "user", text: "thanks" },
    );
    const d = evaluateRecallGate(
      "thanks",
      "Devin is running fine",
      messages,
      2,
    );
    // "thanks" alone would trigger small-talk skip, but "Devin" doesn't
    // appear in "thanks" so safety floor should NOT fire here
    expect(d.skip).toBe(true);
    expect(d.rule).toBe("small-talk");
    expect(d.safetyFloorHit).toBe(false);
  });

  test("safety floor fires when salient token from context appears in meta-query-like text", () => {
    // "/help" is a meta-query and would normally skip, but we test with
    // a user text that matches a rule yet contains a salient token from context.
    // Use rule 4: imperative opener + high ROUGE-L overlapping with context.
    const lastAssistant =
      "Here is the deployment status for Devin project PR #12345";
    const messages = makeMessages(
      { role: "user", text: "Tell me about PR #12345" },
      { role: "assistant", text: lastAssistant },
      {
        role: "user",
        text: "shorter the deployment status for Devin project PR #12345",
      },
    );
    const d = evaluateRecallGate(
      "shorter the deployment status for Devin project PR #12345",
      lastAssistant,
      messages,
      2,
    );
    // This would match continuation-transform (imperative opener + high ROUGE-L),
    // but "Devin" and "#12345" are salient tokens from context → safety floor overrides.
    expect(d.skip).toBe(false);
    expect(d.safetyFloorHit).toBe(true);
    expect(d.safetyFloorTokens.length).toBeGreaterThan(0);
  });

  test("decision metadata is populated", () => {
    const messages = makeMessages({ role: "user", text: "hello" });
    const d = evaluateRecallGate("hello", "", messages, 1);
    expect(d.promptCharCount).toBe(5);
    expect(d.promptTokenEstimate).toBeGreaterThan(0);
    expect(d.hasQuestionMark).toBe(false);
    expect(d.redactedUserText).toBe("hello");
  });

  test("hasQuestionMark detected", () => {
    const messages = makeMessages({
      role: "user",
      text: "Can you help me with the project?",
    });
    const d = evaluateRecallGate(
      "Can you help me with the project?",
      "",
      messages,
      3,
    );
    expect(d.hasQuestionMark).toBe(true);
  });
});
