import { describe, expect, test } from "bun:test";

import { buildFTSQuery, expandQueryForFTS } from "./query-expansion.js";

describe("expandQueryForFTS", () => {
  test("extracts meaningful keywords from conversational input", () => {
    const result = expandQueryForFTS(
      "what did we discuss about the API design?",
    );
    expect(result).toEqual(["discuss", "API", "design"]);
  });

  test("extracts all tokens from technical input (no stop words)", () => {
    const result = expandQueryForFTS("React component lifecycle hooks");
    expect(result).toEqual(["React", "component", "lifecycle", "hooks"]);
  });

  test("returns single keyword as-is", () => {
    const result = expandQueryForFTS("authentication");
    expect(result).toEqual(["authentication"]);
  });

  test("returns wildcard for empty input", () => {
    expect(expandQueryForFTS("")).toEqual(["*"]);
  });

  test("returns wildcard for whitespace-only input", () => {
    expect(expandQueryForFTS("   ")).toEqual(["*"]);
  });

  test("returns original tokens when all are stop words", () => {
    const result = expandQueryForFTS("what is the");
    expect(result).toEqual(["what", "is", "the"]);
  });
});

describe("buildFTSQuery", () => {
  test("joins multiple keywords with OR", () => {
    const result = buildFTSQuery(["API", "design"]);
    expect(result).toBe('"API" OR "design"');
  });

  test("wraps single keyword in quotes", () => {
    const result = buildFTSQuery(["auth"]);
    expect(result).toBe('"auth"');
  });

  test("strips double-quote characters from keywords", () => {
    const result = buildFTSQuery(['say "hello"', "world"]);
    expect(result).toBe('"say hello" OR "world"');
  });
});
