import { describe, expect, test } from "bun:test";

import { createReasoningTagFilter } from "../reasoning-tag-filter.js";

function run(chunks: string[]): string {
  const filter = createReasoningTagFilter();
  let out = "";
  for (const chunk of chunks) {
    out += filter.push(chunk);
  }
  out += filter.flush();
  return out;
}

describe("ReasoningTagFilter", () => {
  test("passes plain text through unchanged", () => {
    expect(run(["Hello ", "there."])).toBe("Hello there.");
  });

  test("drops a complete think span within one delta", () => {
    expect(run(["<think>hm, let me reason</think>Answer."])).toBe("Answer.");
  });

  test("drops a reasoning span crossing many deltas", () => {
    expect(
      run(["<thi", "nk>step one", " step two", "</th", "ink>Spoken reply"]),
    ).toBe("Spoken reply");
  });

  test("drops thinking-tag variant and is case-insensitive", () => {
    expect(run(["<Thinking>inner</Thinking>ok"])).toBe("ok");
  });

  test("keeps text before and after the span", () => {
    expect(run(["Sure. <think>secret</think> Done."])).toBe("Sure.  Done.");
  });

  test("handles multiple spans in one turn", () => {
    expect(run(["a<think>x</think>b", "<think>y", "z</think>c"])).toBe("abc");
  });

  test("an unclosed span at end of stream stays dropped", () => {
    expect(run(["ok<think>never closes"])).toBe("ok");
  });

  test("a dangling partial open tag is released as literal text at flush", () => {
    expect(run(["price <th"])).toBe("price <th");
  });

  test("a false partial that disambiguates to text is released", () => {
    expect(run(["a <th", "ree-step plan"])).toBe("a <three-step plan");
  });

  test("does not touch angle brackets that are not think tags", () => {
    expect(run(["use <b>bold</b> and x < y"])).toBe(
      "use <b>bold</b> and x < y",
    );
  });

  test("holds back nothing across an empty stream", () => {
    expect(run([""])).toBe("");
  });
});
