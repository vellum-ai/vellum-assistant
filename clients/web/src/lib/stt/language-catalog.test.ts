import { describe, expect, test } from "bun:test";

import {
  STT_LANGUAGES,
  STT_MULTI_CODE,
  sttLanguageLabelForCode,
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
    // offering it would be a silent no-op. Minus Multilingual, plus the
    // explicit English pin entry, the count lands back on the base 11.
    const codes = sttLanguageOptionsFor("", "xai").map((o) => o.code);
    expect(codes).not.toContain(STT_MULTI_CODE);
    expect(sttLanguageOptionsFor("", "xai")).toHaveLength(STT_LANGUAGES.length);
  });

  test("reframes the xai default row as Auto-detect", () => {
    // Unset `services.stt.language` under xai means the resolver sends no
    // language and xAI detects it natively; an "English (default)" row
    // misreports that state.
    const options = sttLanguageOptionsFor("", "xai");
    expect(options[0]?.code).toBe("");
    expect(options[0]?.label).toBe("Auto-detect (default)");
    expect(options[0]?.description).toContain("natively");
    // The one-way door is stated plainly: the picker cannot clear the key.
    expect(options[0]?.description).toContain(
      "clearing services.stt.language outside this picker",
    );
  });

  test("offers an explicit English entry for xai ahead of the monolinguals", () => {
    // With the default row meaning auto-detect, pinning English needs its
    // own entry; without one, "en" is unwritable from the picker (a pick of
    // the current default is a no-op).
    const options = sttLanguageOptionsFor("", "xai");
    expect(options[1]).toEqual({ code: "en", label: "English" });
    expect(options[2]?.code).toBe("es");
  });

  test("deepgram and vellum options stay byte-identical to the English-framed catalog", () => {
    // The auto-detect reframe is xai-scoped: deepgram and the managed relay
    // decode unset audio as English, so their rows must not change. Pinned
    // as a deep-equal against the full pre-change expectation.
    const preChangeExpectation = [
      {
        code: "",
        label: "English (default)",
        description: "Speech recognition defaults to English.",
      },
      {
        code: "multi",
        label: "Multilingual",
        description:
          "Follows you between languages mid-sentence: English, Spanish, French, German, Hindi, Russian, Portuguese, Japanese, Italian, and Dutch.",
      },
      { code: "es", label: "Spanish", nativeLabel: "Español" },
      { code: "fr", label: "French", nativeLabel: "Français" },
      { code: "de", label: "German", nativeLabel: "Deutsch" },
      { code: "hi", label: "Hindi", nativeLabel: "हिन्दी" },
      { code: "ru", label: "Russian", nativeLabel: "Русский" },
      { code: "pt", label: "Portuguese", nativeLabel: "Português" },
      { code: "ja", label: "Japanese", nativeLabel: "日本語" },
      { code: "it", label: "Italian", nativeLabel: "Italiano" },
      { code: "nl", label: "Dutch", nativeLabel: "Nederlands" },
    ];
    for (const providerId of ["deepgram", "vellum"]) {
      expect(sttLanguageOptionsFor("", providerId)).toEqual(
        preChangeExpectation,
      );
    }
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

describe("sttLanguageLabelForCode", () => {
  test("labels a catalog code with its native name", () => {
    expect(sttLanguageLabelForCode("fr", "deepgram")).toBe("French (Français)");
  });

  test("labels the default code", () => {
    expect(sttLanguageLabelForCode("", "deepgram")).toBe("English (default)");
  });

  test("labels multi under a multi-capable provider", () => {
    expect(sttLanguageLabelForCode(STT_MULTI_CODE, "vellum")).toBe(
      "Multilingual",
    );
  });

  test("labels multi under xai via the custom fallback", () => {
    // The xai catalog omits Multilingual, so the synthetic entry carries it.
    expect(sttLanguageLabelForCode(STT_MULTI_CODE, "xai")).toBe(
      "multi (custom)",
    );
  });

  test("labels the default code under xai as Auto-detect", () => {
    expect(sttLanguageLabelForCode("", "xai")).toBe("Auto-detect (default)");
  });

  test("labels en under xai as the English pin", () => {
    // Under xai a persisted "en" is a deliberate pin, not the default; the
    // hook leaves it uncollapsed so surfaces pass it through to here.
    expect(sttLanguageLabelForCode("en", "xai")).toBe("English");
  });

  test("labels an out-of-catalog code via the custom fallback", () => {
    expect(sttLanguageLabelForCode("en-US", "deepgram")).toBe("en-US (custom)");
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
