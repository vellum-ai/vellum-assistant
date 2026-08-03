import { describe, expect, test } from "bun:test";

import {
  STT_LANGUAGES,
  STT_MULTI_CODE,
  sttCatalogEntryForLocale,
  sttLanguageGroupsFor,
  sttLanguageLabelForCode,
  sttLanguageMatches,
  sttLanguageOptionsFor,
  suggestedLanguageForLocale,
} from "./language-catalog";

describe("STT_LANGUAGES", () => {
  test("has exactly 50 entries: 2 sentinel rows + 48 monolinguals", () => {
    // The verified nova-3 monolingual roster is 49 base codes; English rides
    // the default-sentinel row, so 48 monolingual entries remain.
    expect(STT_LANGUAGES).toHaveLength(50);
  });

  test("monolingual entries are ordered A-Z by English label", () => {
    const labels = STT_LANGUAGES.slice(2).map((option) => option.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
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

  test("exactly the multi-roster monolinguals are non-extended", () => {
    // The daemon-side parity test pins this same split against the daemon
    // roster; here it guards the local invariant the provider scoping and
    // the multi description depend on.
    const nonExtended = STT_LANGUAGES.slice(2)
      .filter((option) => !option.extended)
      .map((option) => option.code)
      .sort();
    expect(nonExtended).toEqual([
      "de",
      "es",
      "fr",
      "hi",
      "it",
      "ja",
      "nl",
      "pt",
      "ru",
    ]);
  });

  test("every monolingual entry carries the fields search matches on", () => {
    for (const option of STT_LANGUAGES.slice(2)) {
      expect(option.code.length).toBeGreaterThan(0);
      expect(option.label.length).toBeGreaterThan(0);
      // Tagalog's native name is its English name; every other language
      // carries a native label for native-script search.
      if (option.code !== "tl") {
        expect(option.nativeLabel ?? "").not.toBe("");
      }
    }
  });
});

describe("sttLanguageOptionsFor", () => {
  test("returns the catalog unchanged for a catalog code", () => {
    expect(sttLanguageOptionsFor("es", "deepgram")).toBe(STT_LANGUAGES);
  });

  test("returns the catalog unchanged for the default code", () => {
    expect(sttLanguageOptionsFor("", "deepgram")).toBe(STT_LANGUAGES);
  });

  test("includes Multilingual and the extended roster for deepgram and vellum", () => {
    // Both run Deepgram nova-3 (vellum relays with the model pinned
    // server-side): the only place "multi" code-switching works, and the
    // roster the extended entries were verified against.
    for (const providerId of ["deepgram", "vellum"]) {
      const codes = sttLanguageOptionsFor("", providerId).map((o) => o.code);
      expect(codes).toContain(STT_MULTI_CODE);
      expect(codes).toContain("ta");
      expect(codes).toContain("ko");
      expect(codes).toContain("zh");
    }
  });

  test("deepgram and vellum options are identical", () => {
    expect(sttLanguageOptionsFor("", "vellum")).toEqual(
      sttLanguageOptionsFor("", "deepgram"),
    );
  });

  test("omits Multilingual and the extended roster for xai", () => {
    // The resolver drops "multi" before it reaches the xAI adapter, and the
    // extended entries are verified against nova-3 only, so xai keeps the
    // pre-expansion set: Auto-detect + English pin + the 9 multi-roster
    // monolinguals.
    const options = sttLanguageOptionsFor("", "xai");
    const codes = options.map((o) => o.code);
    expect(codes).not.toContain(STT_MULTI_CODE);
    expect(codes).not.toContain("ta");
    expect(codes).not.toContain("ko");
    expect(options).toHaveLength(11);
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
    // The catalog is A-Z, so Dutch leads the remaining monolinguals.
    expect(options[2]?.code).toBe("nl");
  });

  test("deepgram keeps the English-framed default row and Multilingual on top", () => {
    // The auto-detect reframe is xai-scoped: deepgram and the managed relay
    // decode unset audio as English, so their sentinel rows must not change.
    const options = sttLanguageOptionsFor("", "deepgram");
    expect(options[0]).toEqual({
      code: "",
      label: "English (default)",
      description: "Speech recognition defaults to English.",
    });
    expect(options[1]?.code).toBe(STT_MULTI_CODE);
    expect(options[1]?.label).toBe("Multilingual");
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

  test("an extended code under xai renders via the custom fallback", () => {
    // A CLI-written "ta" under xai stays visible even though the xai option
    // set does not offer it.
    const options = sttLanguageOptionsFor("ta", "xai");
    expect(options[options.length - 1]).toEqual({
      code: "ta",
      label: "ta (custom)",
    });
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

describe("sttLanguageGroupsFor", () => {
  test("features the default row and Multilingual for a fresh deepgram config", () => {
    const groups = sttLanguageGroupsFor("", "deepgram");
    expect(groups.featured.map((o) => o.code)).toEqual(["", STT_MULTI_CODE]);
    // Everything else lands in the A-Z remainder, nothing lost.
    expect(groups.rest).toHaveLength(STT_LANGUAGES.length - 2);
    const labels = groups.rest.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  test("puts the current value first and removes it from the remainder", () => {
    const groups = sttLanguageGroupsFor("ta", "deepgram");
    expect(groups.featured.map((o) => o.code)).toEqual([
      "ta",
      "",
      STT_MULTI_CODE,
    ]);
    expect(groups.rest.some((o) => o.code === "ta")).toBe(false);
  });

  test("features the locale suggestion after the pinned rows", () => {
    const groups = sttLanguageGroupsFor("", "deepgram", "ta");
    expect(groups.featured.map((o) => o.code)).toEqual([
      "",
      STT_MULTI_CODE,
      "ta",
    ]);
  });

  test("deduplicates a suggestion that is already featured", () => {
    const groups = sttLanguageGroupsFor("", "deepgram", STT_MULTI_CODE);
    expect(groups.featured.map((o) => o.code)).toEqual(["", STT_MULTI_CODE]);
  });

  test("skips a suggested code the provider does not offer", () => {
    // xai never offers the extended roster, so a "ta" suggestion cannot be
    // invented for it.
    const groups = sttLanguageGroupsFor("", "xai", "ta");
    expect(groups.featured.map((o) => o.code)).toEqual([""]);
    expect(groups.rest.some((o) => o.code === "ta")).toBe(false);
  });

  test("features a custom current value so the persisted truth stays on top", () => {
    const groups = sttLanguageGroupsFor("en-US", "deepgram");
    expect(groups.featured[0]).toEqual({
      code: "en-US",
      label: "en-US (custom)",
    });
  });

  test("featured plus rest is exactly the provider option set", () => {
    const groups = sttLanguageGroupsFor("ta", "deepgram", STT_MULTI_CODE);
    const together = [...groups.featured, ...groups.rest]
      .map((o) => o.code)
      .sort();
    const options = sttLanguageOptionsFor("ta", "deepgram")
      .map((o) => o.code)
      .sort();
    expect(together).toEqual(options);
  });
});

describe("sttLanguageMatches", () => {
  const byCode = (code: string) =>
    STT_LANGUAGES.find((option) => option.code === code)!;

  test("matches label substrings, so 'ta' hits Tamil, Tagalog, Italian, and Catalan", () => {
    // Substring on labels deliberately over-matches: recall beats precision
    // in a ~50-row list (see the matcher's doc).
    for (const code of ["ta", "tl", "it", "ca"]) {
      expect(sttLanguageMatches(byCode(code), "ta")).toBe(true);
    }
    expect(sttLanguageMatches(byCode("fr"), "ta")).toBe(false);
  });

  test("matches native labels, so a native-script query works", () => {
    expect(sttLanguageMatches(byCode("ta"), "தமிழ்")).toBe(true);
    expect(sttLanguageMatches(byCode("hi"), "हिन्")).toBe(true);
  });

  test("matches codes by prefix, not substring", () => {
    // "zh" appears nowhere in "Chinese" / "中文"; the code carries the match.
    expect(sttLanguageMatches(byCode("zh"), "zh")).toBe(true);
    // Czech isolates the code rule: neither "Czech" nor "Čeština" contains
    // a plain "s", so only the code could match a bare "s" query, and the
    // prefix rule says it must not ("cs" starts with "c", not "s").
    expect(sttLanguageMatches(byCode("cs"), "c")).toBe(true);
    expect(sttLanguageMatches(byCode("cs"), "s")).toBe(false);
  });

  test("is case-insensitive and trims the query", () => {
    expect(sttLanguageMatches(byCode("ta"), "  TAM ")).toBe(true);
  });

  test("an empty or whitespace query matches everything", () => {
    expect(sttLanguageMatches(byCode("ta"), "")).toBe(true);
    expect(sttLanguageMatches(byCode("ta"), "   ")).toBe(true);
  });
});

describe("sttLanguageLabelForCode", () => {
  test("labels a catalog code with its native name", () => {
    expect(sttLanguageLabelForCode("fr", "deepgram")).toBe("French (Français)");
  });

  test("labels an extended code with its native name", () => {
    expect(sttLanguageLabelForCode("ta", "deepgram")).toBe("Tamil (தமிழ்)");
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

describe("sttCatalogEntryForLocale", () => {
  test("maps a regional locale to its catalog entry", () => {
    expect(sttCatalogEntryForLocale("hi-IN")?.code).toBe("hi");
    expect(sttCatalogEntryForLocale("ta-IN")?.code).toBe("ta");
  });

  test("returns null for English, empty, undefined, and out-of-catalog locales", () => {
    expect(sttCatalogEntryForLocale("en-US")).toBeNull();
    expect(sttCatalogEntryForLocale("")).toBeNull();
    expect(sttCatalogEntryForLocale(undefined)).toBeNull();
    // Welsh is not on the nova-3 roster.
    expect(sttCatalogEntryForLocale("cy-GB")).toBeNull();
  });
});

describe("suggestedLanguageForLocale", () => {
  test("returns null for English locales under every provider", () => {
    for (const providerId of ["deepgram", "vellum", "xai"]) {
      expect(suggestedLanguageForLocale("en-US", providerId)).toBeNull();
    }
  });

  test("returns null for undefined", () => {
    expect(suggestedLanguageForLocale(undefined, "deepgram")).toBeNull();
  });

  test("returns null for the empty string", () => {
    expect(suggestedLanguageForLocale("", "deepgram")).toBeNull();
  });

  test("returns null for a subtag outside the catalog", () => {
    // Welsh is not on the nova-3 roster.
    expect(suggestedLanguageForLocale("cy-GB", "deepgram")).toBeNull();
  });

  test("returns multi for a code-switching-roster locale under a multi-capable provider", () => {
    // A multi-roster-language speaker talking to an English-speaking
    // assistant is exactly the code-switching case.
    expect(suggestedLanguageForLocale("hi-IN", "deepgram")).toBe(
      STT_MULTI_CODE,
    );
    expect(suggestedLanguageForLocale("hi-IN", "vellum")).toBe(STT_MULTI_CODE);
  });

  test("falls back to the monolingual pin where the provider lacks multi", () => {
    // xai's option set omits Multilingual, but "hi" is in every
    // language-selectable provider's set, so the suggestion degrades to the
    // pin instead of vanishing.
    expect(suggestedLanguageForLocale("hi-IN", "xai")).toBe("hi");
  });

  test("returns the monolingual pin for an extended-roster locale where nova-3 runs", () => {
    // Tamil is outside what "multi" can follow, so the suggestion is the
    // monolingual pin itself.
    expect(suggestedLanguageForLocale("ta-IN", "deepgram")).toBe("ta");
    expect(suggestedLanguageForLocale("ta-IN", "vellum")).toBe("ta");
    expect(suggestedLanguageForLocale("ko-KR", "deepgram")).toBe("ko");
  });

  test("returns null for an extended-roster locale under a provider without the extended set", () => {
    // xai never offers "ta", so there is nothing valid to suggest and the
    // first-run row stays hidden.
    expect(suggestedLanguageForLocale("ta-IN", "xai")).toBeNull();
    expect(suggestedLanguageForLocale("ko-KR", "xai")).toBeNull();
  });

  test("normalizes case", () => {
    expect(suggestedLanguageForLocale("HI", "deepgram")).toBe(STT_MULTI_CODE);
  });

  test("takes the primary subtag of a regional locale", () => {
    expect(suggestedLanguageForLocale("pt-BR", "deepgram")).toBe(
      STT_MULTI_CODE,
    );
  });
});
