import { describe, expect, test } from "bun:test";

import { deepgramModelOverrideForLanguage } from "../deepgram.js";

describe("deepgramModelOverrideForLanguage", () => {
  test('"multi" pins nova-3 (the only model that accepts code-switching)', () => {
    expect(deepgramModelOverrideForLanguage("multi")).toEqual({
      model: "nova-3",
    });
  });

  test("a specific language returns no override, keeping the caller's default model", () => {
    expect(deepgramModelOverrideForLanguage("hi")).toEqual({});
  });

  test("an unset language returns no override", () => {
    expect(deepgramModelOverrideForLanguage(undefined)).toEqual({});
  });
});
