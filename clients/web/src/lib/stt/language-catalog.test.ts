import { describe, expect, test } from "bun:test";

import {
  STT_LANGUAGES,
  STT_MULTI_CODE,
  sttLanguageOptionsFor,
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

describe("sttLanguageOptionsFor", () => {
  test("returns the catalog unchanged for a catalog code", () => {
    expect(sttLanguageOptionsFor("es", "deepgram")).toBe(STT_LANGUAGES);
  });

  test("returns the catalog unchanged for the default code", () => {
    expect(sttLanguageOptionsFor("", "deepgram")).toBe(STT_LANGUAGES);
  });

  test("includes Multilingual for deepgram and vellum", () => {
    // Both run Deepgram nova-3 (vellum relays with the model pinned
    // server-side), the only place "multi" code-switching works.
    for (const providerId of ["deepgram", "vellum"]) {
      const codes = sttLanguageOptionsFor("", providerId).map((o) => o.code);
      expect(codes).toContain(STT_MULTI_CODE);
    }
  });

  test("omits Multilingual for xai", () => {
    // The resolver drops "multi" before it reaches the xAI adapter, so
    // offering it would be a silent no-op.
    const codes = sttLanguageOptionsFor("", "xai").map((o) => o.code);
    expect(codes).not.toContain(STT_MULTI_CODE);
    expect(sttLanguageOptionsFor("", "xai")).toHaveLength(
      STT_LANGUAGES.length - 1,
    );
  });

  test("a persisted multi under xai still renders via the custom fallback", () => {
    // The picker shows the persisted truth even when the provider ignores
    // it; a trigger that renders blank invites an accidental overwrite.
    const options = sttLanguageOptionsFor(STT_MULTI_CODE, "xai");
    expect(options[options.length - 1]).toEqual({
      code: STT_MULTI_CODE,
      label: "multi (custom)",
    });
    // The catalog's own Multilingual entry stays out; only the fallback
    // carries the code.
    expect(options.filter((o) => o.code === STT_MULTI_CODE)).toHaveLength(1);
  });

  test("appends a custom entry for an out-of-catalog code", () => {
    // `services.stt.language` accepts any non-empty string; a CLI-written
    // "en-US" must stay visible in the picker instead of a blank trigger.
    const options = sttLanguageOptionsFor("en-US", "deepgram");
    expect(options).toHaveLength(STT_LANGUAGES.length + 1);
    expect(options[options.length - 1]).toEqual({
      code: "en-US",
      label: "en-US (custom)",
    });
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
