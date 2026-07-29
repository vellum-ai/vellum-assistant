import { describe, expect, test } from "bun:test";

import {
  STT_LANGUAGES,
  STT_MULTI_CODE,
  suggestedLanguageForLocale,
} from "./language-catalog";

describe("STT_LANGUAGES", () => {
  test("has exactly 11 entries", () => {
    expect(STT_LANGUAGES).toHaveLength(11);
  });

  test("the multi description names all 10 supported languages", () => {
    const multi = STT_LANGUAGES.find(
      (option) => option.code === STT_MULTI_CODE,
    );
    expect(multi).toBeDefined();
    const description = multi?.description ?? "";
    expect(description).toContain("English");
    expect(description).toContain("Spanish");
    expect(description).toContain("French");
    expect(description).toContain("German");
    expect(description).toContain("Hindi");
    expect(description).toContain("Russian");
    expect(description).toContain("Portuguese");
    expect(description).toContain("Japanese");
    expect(description).toContain("Italian");
    expect(description).toContain("Dutch");
  });
});

describe("suggestedLanguageForLocale", () => {
  test("returns null for English locales", () => {
    expect(suggestedLanguageForLocale("en-US")).toBeNull();
  });

  test("returns null for undefined", () => {
    expect(suggestedLanguageForLocale(undefined)).toBeNull();
  });

  test("returns null for the empty string", () => {
    expect(suggestedLanguageForLocale("")).toBeNull();
  });

  test("returns null for a subtag outside the catalog", () => {
    expect(suggestedLanguageForLocale("ta-IN")).toBeNull();
  });

  test("returns multi for a supported non-English locale", () => {
    expect(suggestedLanguageForLocale("hi-IN")).toBe(STT_MULTI_CODE);
  });

  test("normalizes case", () => {
    expect(suggestedLanguageForLocale("HI")).toBe(STT_MULTI_CODE);
  });

  test("takes the primary subtag of a regional locale", () => {
    expect(suggestedLanguageForLocale("pt-BR")).toBe(STT_MULTI_CODE);
  });
});
