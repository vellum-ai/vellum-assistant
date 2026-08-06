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
  test("has exactly 51 entries: 2 sentinel rows + 49 monolinguals", () => {
    // The verified nova-3 monolingual roster is 50 base codes; English rides
    // the default-sentinel row, so 49 monolingual entries remain.
    expect(STT_LANGUAGES).toHaveLength(51);
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
  test("keeps every monolingual entry for a catalog code", () => {
    // The sentinel rows are reframed per provider, but the monolingual body
    // of the catalog passes through untouched.
    const codes = sttLanguageOptionsFor("es", "deepgram").map((o) => o.code);
    for (const option of STT_LANGUAGES) {
      if (option.code === "" || option.code === STT_MULTI_CODE) {
        continue;
      }
      expect(codes).toContain(option.code);
    }
  });

  test("includes the extended roster for deepgram and vellum", () => {
    // Both run Deepgram nova-3 (vellum relays with the model pinned
    // server-side), the roster the extended entries were verified against.
    for (const providerId of ["deepgram", "vellum"]) {
      const codes = sttLanguageOptionsFor("", providerId).map((o) => o.code);
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

  test("offers Multilingual and English as separate rows, with no sentinel", () => {
    // Config always carries a real language now, so there is no "default"
    // state for a sentinel row to stand in for, and Multilingual is a thing
    // you pick rather than a thing you fall back to.
    for (const providerId of ["deepgram", "vellum"]) {
      const options = sttLanguageOptionsFor("multi", providerId);
      const codes = options.map((o) => o.code);
      expect(codes).not.toContain("");
      expect(codes).toContain(STT_MULTI_CODE);
      expect(codes).toContain("en");
    }
  });

  test("leads with English and Multilingual ahead of the monolinguals", () => {
    const options = sttLanguageOptionsFor("multi", "deepgram");
    expect(options[0]).toEqual({ code: "en", label: "English" });
    expect(options[1]?.code).toBe(STT_MULTI_CODE);
    expect(options[1]?.label).toBe("Multilingual");
    // Arabic leads the A-Z monolinguals on the extended roster.
    expect(options[2]?.code).toBe("ar");
  });

  test("Multilingual keeps the roster in its description", () => {
    const options = sttLanguageOptionsFor("multi", "deepgram");
    const multi = options.find((o) => o.code === STT_MULTI_CODE);
    expect(multi?.description).toContain("mid-sentence");
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
  test("features Multilingual and English for a fresh deepgram config", () => {
    const groups = sttLanguageGroupsFor("multi", "deepgram", null);
    expect(groups.featured.map((o) => o.code)).toEqual([STT_MULTI_CODE, "en"]);
    // Everything else lands in the A-Z remainder, nothing lost: the catalog
    // trades its sentinel row for the English pin, so the total is unchanged.
    expect(groups.rest).toHaveLength(STT_LANGUAGES.length - 2);
    const labels = groups.rest.map((o) => o.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  test("puts the current value first and removes it from the remainder", () => {
    const groups = sttLanguageGroupsFor("ta", "deepgram", null);
    expect(groups.featured.map((o) => o.code)).toEqual([
      "ta",
      STT_MULTI_CODE,
      "en",
    ]);
    expect(groups.rest.some((o) => o.code === "ta")).toBe(false);
  });

  test("features the locale suggestion after the pinned rows", () => {
    const groups = sttLanguageGroupsFor("multi", "deepgram", "ta");
    expect(groups.featured.map((o) => o.code)).toEqual([
      STT_MULTI_CODE,
      "en",
      "ta",
    ]);
  });

  test("deduplicates a suggestion that is already featured", () => {
    const groups = sttLanguageGroupsFor("multi", "deepgram", "en");
    expect(groups.featured.map((o) => o.code)).toEqual([STT_MULTI_CODE, "en"]);
  });

  test("skips a suggested code the provider does not offer", () => {
    // xai never offers the extended roster, so a "ta" suggestion cannot be
    // invented for it.
    const groups = sttLanguageGroupsFor("", "xai", "ta");
    expect(groups.featured.map((o) => o.code)).toEqual(["", "en"]);
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
    const groups = sttLanguageGroupsFor("ta", "deepgram", "en");
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

  test("labels multi as Multilingual on the providers that run it", () => {
    expect(sttLanguageLabelForCode(STT_MULTI_CODE, "deepgram")).toBe(
      "Multilingual",
    );
    expect(sttLanguageLabelForCode(STT_MULTI_CODE, "vellum")).toBe(
      "Multilingual",
    );
  });

  test("labels en under deepgram as the English pin", () => {
    // A persisted "en" is now a deliberate pin rather than the default, so
    // the trigger row has to say English, not "Multilingual (default)".
    expect(sttLanguageLabelForCode("en", "deepgram")).toBe("English");
  });

  test("labels multi via the custom fallback under xai, which never offers it", () => {
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

  test("returns null for a code-switching-roster locale when already on multi", () => {
    // A Hindi speaker on code-switching is already understood, so there is
    // nothing to suggest and the first-run row stays hidden.
    expect(
      suggestedLanguageForLocale("hi-IN", "deepgram", STT_MULTI_CODE),
    ).toBeNull();
    expect(
      suggestedLanguageForLocale("hi-IN", "vellum", STT_MULTI_CODE),
    ).toBeNull();
  });

  test("returns null under xai while unset, which is native detection", () => {
    // xai's unset state detects the language from the audio, so this speaker
    // is already understood and there is nothing to propose.
    expect(suggestedLanguageForLocale("hi-IN", "xai")).toBeNull();
  });

  test("returns the monolingual pin when xai has English pinned", () => {
    // A real pin overrides native detection, so the row comes back for the
    // one thing xai's option set can offer.
    expect(suggestedLanguageForLocale("hi-IN", "xai", "en")).toBe("hi");
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
    expect(suggestedLanguageForLocale("TA", "deepgram")).toBe("ta");
  });

  test("takes the primary subtag of a regional locale", () => {
    // zh is extended-roster, so a regional Chinese locale still suggests.
    expect(suggestedLanguageForLocale("zh-TW", "deepgram")).toBe("zh");
  });
});

describe("suggestions follow the current selection, not just the default", () => {
  // The provider default only settles whether a speaker is covered when the
  // user is actually on it. Someone who pinned a language is transcribed as
  // that language regardless of what unset would have meant.

  test("an explicit English pin still gets a suggestion on a Hindi locale", () => {
    // The case the row exists for: a persisted "en" (the old picker's default
    // row wrote exactly this) means the session keeps hearing English.
    expect(suggestedLanguageForLocale("hi-IN", "deepgram", "en")).toBe(
      STT_MULTI_CODE,
    );
  });

  test("a pin that does not cover the locale points at code-switching", () => {
    expect(suggestedLanguageForLocale("hi-IN", "deepgram", "es")).toBe(
      STT_MULTI_CODE,
    );
  });

  test("an explicit multi pin suggests nothing", () => {
    expect(
      suggestedLanguageForLocale("hi-IN", "deepgram", STT_MULTI_CODE),
    ).toBeNull();
  });

  test("a pin matching the locale exactly suggests nothing", () => {
    expect(suggestedLanguageForLocale("ta-IN", "deepgram", "ta")).toBeNull();
    expect(suggestedLanguageForLocale("hi-IN", "deepgram", "hi")).toBeNull();
  });
});
