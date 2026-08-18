import { describe, expect, test } from "bun:test";

import { baseLanguageSubtag, localizedOrDefault } from "../language-subtag.js";

describe("baseLanguageSubtag", () => {
  test("lowercases a bare tag", () => {
    expect(baseLanguageSubtag("EN")).toBe("en");
  });

  test("strips a hyphenated region", () => {
    expect(baseLanguageSubtag("en-US")).toBe("en");
    expect(baseLanguageSubtag("PT-br")).toBe("pt");
  });

  test("strips an underscore-separated region", () => {
    expect(baseLanguageSubtag("hi_IN")).toBe("hi");
    expect(baseLanguageSubtag("es_419")).toBe("es");
  });

  test("trims surrounding whitespace", () => {
    expect(baseLanguageSubtag("  hi ")).toBe("hi");
    expect(baseLanguageSubtag(" pt-BR ")).toBe("pt");
  });

  test("returns undefined for undefined and blank input", () => {
    expect(baseLanguageSubtag(undefined)).toBeUndefined();
    expect(baseLanguageSubtag("")).toBeUndefined();
    expect(baseLanguageSubtag("   ")).toBeUndefined();
  });
});

describe("localizedOrDefault", () => {
  const table: Readonly<Record<string, string>> = { en: "hello", es: "hola" };

  test("selects by the language's base subtag", () => {
    expect(localizedOrDefault(table, "es", "hello")).toBe("hola");
    expect(localizedOrDefault(table, "ES-mx", "hello")).toBe("hola");
    expect(localizedOrDefault(table, "en_GB", "fallback")).toBe("hello");
  });

  test("falls back for unset, blank, and unknown languages", () => {
    expect(localizedOrDefault(table, undefined, "fallback")).toBe("fallback");
    expect(localizedOrDefault(table, "", "fallback")).toBe("fallback");
    expect(localizedOrDefault(table, "ko", "fallback")).toBe("fallback");
  });

  test("never resolves prototype keys as entries", () => {
    expect(localizedOrDefault(table, "constructor", "fallback")).toBe(
      "fallback",
    );
    expect(localizedOrDefault(table, "toString", "fallback")).toBe("fallback");
    expect(localizedOrDefault(table, "__proto__", "fallback")).toBe("fallback");
  });
});
