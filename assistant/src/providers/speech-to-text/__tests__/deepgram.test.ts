import { describe, expect, test } from "bun:test";

import { deepgramLanguageOptions } from "../deepgram.js";

describe("deepgramLanguageOptions", () => {
  test('"multi" pairs the language with nova-3 (the only model that accepts code-switching)', () => {
    expect(deepgramLanguageOptions("multi")).toEqual({
      model: "nova-3",
      language: "multi",
    });
  });

  test("a specific language pins nova-3 alongside it (the model the roster is verified for)", () => {
    expect(deepgramLanguageOptions("hi")).toEqual({
      model: "nova-3",
      language: "hi",
    });
  });

  test("an unset language returns no options at all", () => {
    expect(deepgramLanguageOptions(undefined)).toEqual({});
  });

  test("an empty-string language returns no options at all", () => {
    expect(deepgramLanguageOptions("")).toEqual({});
  });
});
