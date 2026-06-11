import { describe, expect, test } from "bun:test";

import {
  rougeL,
  ruleContinuationTransform,
  ruleFirstTurnOneShot,
  ruleMetaQuery,
  ruleSmallTalk,
  ruleToolResultOnly,
} from "../rules.js";

// ---------------------------------------------------------------------------
// Rule 1 — Tool-result only / empty text
// ---------------------------------------------------------------------------
describe("ruleToolResultOnly", () => {
  test("empty string → skip", () => {
    const r = ruleToolResultOnly("");
    expect(r).toEqual({ skip: true, rule: "tool-result-only" });
  });

  test("whitespace-only → skip", () => {
    const r = ruleToolResultOnly("   \n\t  ");
    expect(r).toEqual({ skip: true, rule: "tool-result-only" });
  });

  test("non-empty user text → null (no match)", () => {
    expect(ruleToolResultOnly("hello")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — First turn, short, no entities
// ---------------------------------------------------------------------------
describe("ruleFirstTurnOneShot", () => {
  test("turn 1, short, no entities → skip", () => {
    const r = ruleFirstTurnOneShot("hi there", 1, false);
    expect(r).toEqual({ skip: true, rule: "first-turn-one-shot" });
  });

  test("turn 1 with entities → null", () => {
    expect(ruleFirstTurnOneShot("hi", 1, true)).toBeNull();
  });

  test("turn > 1, short, no entities → null", () => {
    expect(ruleFirstTurnOneShot("hi", 2, false)).toBeNull();
  });

  test("turn 1, ≥40 chars, no entities → null", () => {
    const longText = "a".repeat(40);
    expect(ruleFirstTurnOneShot(longText, 1, false)).toBeNull();
  });

  test("turn 1, exactly 39 chars, no entities → skip", () => {
    const text = "a".repeat(39);
    expect(ruleFirstTurnOneShot(text, 1, false)).toEqual({
      skip: true,
      rule: "first-turn-one-shot",
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — Meta-query
// ---------------------------------------------------------------------------
describe("ruleMetaQuery", () => {
  test('"/help" → skip', () => {
    expect(ruleMetaQuery("/help")).toEqual({ skip: true, rule: "meta-query" });
  });

  test('"what model are you" → skip', () => {
    expect(ruleMetaQuery("what model are you")).toEqual({
      skip: true,
      rule: "meta-query",
    });
  });

  test('"What can you do" → skip (case-insensitive)', () => {
    expect(ruleMetaQuery("What can you do")).toEqual({
      skip: true,
      rule: "meta-query",
    });
  });

  test('"who are you" → skip', () => {
    expect(ruleMetaQuery("who are you")).toEqual({
      skip: true,
      rule: "meta-query",
    });
  });

  test('"help me with my code" → null (not a meta-query)', () => {
    expect(ruleMetaQuery("help me with my code")).toBeNull();
  });

  test("empty string → null", () => {
    expect(ruleMetaQuery("")).toBeNull();
  });

  test('"/status" → skip', () => {
    expect(ruleMetaQuery("/status")).toEqual({
      skip: true,
      rule: "meta-query",
    });
  });
});

// ---------------------------------------------------------------------------
// Rule 4 — Continuation / transform
// ---------------------------------------------------------------------------
describe("ruleContinuationTransform", () => {
  test("imperative opener + high ROUGE-L → skip", () => {
    const lastAssistant =
      "Here is the summary of the project goals and timeline for the quarter";
    const userText =
      "shorter the summary of the project goals and timeline for the quarter";
    const r = ruleContinuationTransform(userText, lastAssistant);
    expect(r).toEqual({ skip: true, rule: "continuation-transform" });
  });

  test("imperative opener but low ROUGE-L → null", () => {
    const lastAssistant = "The cat sat on the mat";
    const userText = "summarize the entire architecture of the system";
    expect(ruleContinuationTransform(userText, lastAssistant)).toBeNull();
  });

  test("high ROUGE-L but no imperative opener → null", () => {
    const lastAssistant =
      "Here is the summary of the project goals and timeline";
    const userText = "I love the summary of the project goals and timeline";
    expect(ruleContinuationTransform(userText, lastAssistant)).toBeNull();
  });

  test("empty last assistant text → null", () => {
    expect(ruleContinuationTransform("shorter please", "")).toBeNull();
  });

  test('"make it shorter" with similar text → skip', () => {
    const lastAssistant =
      "This is a detailed explanation of the memory retrieval pipeline";
    const userText =
      "make it a detailed explanation of the memory retrieval pipeline shorter";
    const r = ruleContinuationTransform(userText, lastAssistant);
    expect(r).toEqual({ skip: true, rule: "continuation-transform" });
  });

  test('"translate to" opener matches', () => {
    const lastAssistant = "Voici un long texte en français qui parle de choses";
    const userText = "translate un long texte en français qui parle de choses";
    const r = ruleContinuationTransform(userText, lastAssistant);
    expect(r).toEqual({ skip: true, rule: "continuation-transform" });
  });
});

// ---------------------------------------------------------------------------
// ROUGE-L
// ---------------------------------------------------------------------------
describe("rougeL", () => {
  test("identical strings → 1.0", () => {
    expect(rougeL("the cat sat", "the cat sat")).toBe(1.0);
  });

  test("no overlap → 0", () => {
    expect(rougeL("hello world", "foo bar")).toBe(0);
  });

  test("partial overlap", () => {
    const score = rougeL("the cat sat on the mat", "the cat on mat");
    expect(score).toBeGreaterThan(0.5);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  test("empty strings → 0", () => {
    expect(rougeL("", "something")).toBe(0);
    expect(rougeL("something", "")).toBe(0);
    expect(rougeL("", "")).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Rule 5 — Small-talk
// ---------------------------------------------------------------------------
describe("ruleSmallTalk", () => {
  test('"hi" with no entities → skip', () => {
    expect(ruleSmallTalk("hi", false)).toEqual({
      skip: true,
      rule: "small-talk",
    });
  });

  test('"hey thanks" → skip', () => {
    expect(ruleSmallTalk("hey thanks", false)).toEqual({
      skip: true,
      rule: "small-talk",
    });
  });

  test('"cool" → skip', () => {
    expect(ruleSmallTalk("cool", false)).toEqual({
      skip: true,
      rule: "small-talk",
    });
  });

  test('"good morning" → skip', () => {
    expect(ruleSmallTalk("good morning", false)).toEqual({
      skip: true,
      rule: "small-talk",
    });
  });

  test("question mark → null", () => {
    expect(ruleSmallTalk("hello?", false)).toBeNull();
  });

  test("has entities → null", () => {
    expect(ruleSmallTalk("hi", true)).toBeNull();
  });

  test("≥40 chars → null", () => {
    expect(ruleSmallTalk("thanks " + "a".repeat(40), false)).toBeNull();
  });

  test("non-small-talk text → null", () => {
    expect(ruleSmallTalk("implement the feature", false)).toBeNull();
  });
});
