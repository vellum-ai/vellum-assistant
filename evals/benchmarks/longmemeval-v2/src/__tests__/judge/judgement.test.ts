import { describe, expect, test } from "bun:test";

import {
  parseLlmBinaryJudgement,
  stripMarkdownCodeFence,
} from "../../judge/judgement";

describe("stripMarkdownCodeFence", () => {
  test("removes leading and trailing triple-backtick fences", () => {
    const text = '```json\n{"label": 1}\n```';
    expect(stripMarkdownCodeFence(text)).toBe('{"label": 1}');
  });

  test("passes through non-fenced text unchanged", () => {
    expect(stripMarkdownCodeFence('{"label": 0}')).toBe('{"label": 0}');
  });
});

describe("parseLlmBinaryJudgement", () => {
  test("parses strict JSON with label=1 and reason", () => {
    const result = parseLlmBinaryJudgement(
      '{"label": 1, "reason": "identified flaw"}',
    );
    expect(result).toEqual({ label: 1, reason: "identified flaw" });
  });

  test("parses strict JSON with label=0", () => {
    const result = parseLlmBinaryJudgement('{"label": 0, "reason": "wrong"}');
    expect(result).toEqual({ label: 0, reason: "wrong" });
  });

  test("strips a code fence before JSON parse", () => {
    const result = parseLlmBinaryJudgement(
      '```\n{"label": 1, "reason": "ok"}\n```',
    );
    expect(result).toEqual({ label: 1, reason: "ok" });
  });

  test("strips a code fence with a language tag", () => {
    const result = parseLlmBinaryJudgement(
      '```json\n{"label": 0, "reason": "nope"}\n```',
    );
    expect(result).toEqual({ label: 0, reason: "nope" });
  });

  test("accepts label as a stringy 0 or 1", () => {
    expect(
      parseLlmBinaryJudgement('{"label": "1", "reason": "yep"}').label,
    ).toBe(1);
    expect(
      parseLlmBinaryJudgement('{"label": "0", "reason": "nope"}').label,
    ).toBe(0);
  });

  test("falls back to regex when JSON is malformed", () => {
    const text = "Here is my judgement: {label: 1, reason: oops}";
    const result = parseLlmBinaryJudgement(text);
    expect(result.label).toBe(1);
    // Regex fallback returns the whole cleaned string as the reason.
    expect(result.reason).toContain("label");
  });

  test("regex fallback accepts single-quoted label key", () => {
    const result = parseLlmBinaryJudgement("{'label': 0}");
    expect(result.label).toBe(0);
  });

  test("regex fallback accepts label=1 shorthand", () => {
    const result = parseLlmBinaryJudgement("Output: label=1, reason=ok");
    expect(result.label).toBe(1);
  });

  test("throws on empty input", () => {
    expect(() => parseLlmBinaryJudgement("")).toThrow(/Empty judgement/);
    expect(() => parseLlmBinaryJudgement("   ")).toThrow(/Empty judgement/);
  });

  test("throws when no label can be extracted", () => {
    expect(() => parseLlmBinaryJudgement("I refuse to answer")).toThrow(
      /Could not parse evaluator binary judgement/,
    );
  });

  test("throws when JSON has a non-binary label and no shorthand fallback hits", () => {
    expect(() => parseLlmBinaryJudgement('{"label": "maybe"}')).toThrow(
      /Could not parse evaluator binary judgement/,
    );
  });
});
