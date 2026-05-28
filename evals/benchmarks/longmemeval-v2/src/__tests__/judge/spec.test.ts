import { describe, expect, test } from "bun:test";

import { parseEvalFunctionSpec, parseEvalValue } from "../../judge/spec";

describe("parseEvalFunctionSpec", () => {
  test("bare function name with no kwargs", () => {
    expect(parseEvalFunctionSpec("norm_phrase_set_match")).toEqual({
      name: "norm_phrase_set_match",
      kwargs: {},
    });
  });

  test("converts snake_case kwarg keys to camelCase", () => {
    const parsed = parseEvalFunctionSpec(
      "norm_phrase_set_match|require_non_empty=false",
    );
    expect(parsed.name).toBe("norm_phrase_set_match");
    expect(parsed.kwargs).toEqual({ requireNonEmpty: false });
  });

  test("parses bool true/false case-insensitively", () => {
    const parsed = parseEvalFunctionSpec(
      "norm_phrase_set_match|lower=TRUE|strip_punct=False",
    );
    expect(parsed.kwargs).toEqual({ lower: true, stripPunct: false });
  });

  test("special-cases separators with empty value", () => {
    expect(
      parseEvalFunctionSpec("norm_phrase_set_match|separators=").kwargs,
    ).toEqual({ separators: [] });
  });

  test("special-cases separators with single char", () => {
    expect(
      parseEvalFunctionSpec("norm_phrase_set_match_ordered|separators=>")
        .kwargs,
    ).toEqual({ separators: [">"] });
  });

  test("special-cases separators with bracketed JSON list", () => {
    // Note: `|` is reserved as the spec-level kwarg separator and cannot
    // appear inside a JSON list value — the input would already be
    // pipe-split before this branch runs. This matches V2's Python behavior.
    expect(
      parseEvalFunctionSpec('mc_choice_set_match|separators=[",", ";"]').kwargs,
    ).toEqual({ separators: [",", ";"] });
  });

  test("parses none/null to null", () => {
    expect(
      parseEvalFunctionSpec("mc_choice_match|strip_chars=NONE").kwargs,
    ).toEqual({ stripChars: null });
  });

  test("parses integers and floats", () => {
    const parsed = parseEvalFunctionSpec(
      "norm_phrase_set_match|some_int=42|some_float=1.5",
    );
    expect(parsed.kwargs).toEqual({ someInt: 42, someFloat: 1.5 });
  });

  test("leaves non-numeric values as strings", () => {
    expect(
      parseEvalFunctionSpec("mc_choice_match|strip_chars=.").kwargs,
    ).toEqual({ stripChars: "." });
  });

  test("rejects empty spec", () => {
    expect(() => parseEvalFunctionSpec("")).toThrow(/non-empty string/);
  });

  test("rejects non-string spec", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(() => parseEvalFunctionSpec(42 as any)).toThrow(/non-empty string/);
  });

  test("rejects kwargs missing =", () => {
    expect(() =>
      parseEvalFunctionSpec("norm_phrase_set_match|noequals"),
    ).toThrow(/Invalid eval function option/);
  });

  test("rejects duplicate kwarg keys", () => {
    expect(() =>
      parseEvalFunctionSpec("norm_phrase_set_match|lower=true|lower=false"),
    ).toThrow(/Duplicate eval function option/);
  });

  test("rejects empty kwarg key", () => {
    expect(() => parseEvalFunctionSpec("norm_phrase_set_match|=value")).toThrow(
      /Invalid eval function option/,
    );
  });
});

describe("parseEvalValue", () => {
  test("integer-shaped values parse as int", () => {
    expect(parseEvalValue("some_int", "42")).toBe(42);
    expect(parseEvalValue("some_int", "-3")).toBe(-3);
  });

  test("float-shaped values parse as float", () => {
    expect(parseEvalValue("some_float", "1.5")).toBe(1.5);
  });

  test("numeric-with-trailing-text stays a string", () => {
    expect(parseEvalValue("some_str", "12abc")).toBe("12abc");
  });
});
