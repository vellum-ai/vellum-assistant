import { describe, expect, test } from "bun:test";

import {
  NAMING_REGIONS,
  PERSONALITY_GROUP_IDS,
  allNamesForRegion,
  formatNamingFunnelScreen,
  namesForRegion,
  pickAssistantName,
  regionFromLocaleTag,
  regionFromTimezone,
  resolveAssistantNamePool,
  resolveNamingRegion,
  sampleSuggestionNames,
} from "@/domains/onboarding/assistant-name-pool";

describe("regionFromLocaleTag", () => {
  test("maps language tags onto curated naming regions", () => {
    expect(regionFromLocaleTag("nl-NL")).toBe("nl");
    expect(regionFromLocaleTag("pt_BR")).toBe("pt");
    expect(regionFromLocaleTag("es-MX")).toBe("es");
    expect(regionFromLocaleTag("zh-Hans-CN")).toBe("zh");
    expect(regionFromLocaleTag("zh-Hant-TW")).toBe("zh-TW");
    expect(regionFromLocaleTag("zh-TW")).toBe("zh-TW");
    expect(regionFromLocaleTag("ko")).toBe("ko");
  });

  test("returns null for languages without a curated pool", () => {
    expect(regionFromLocaleTag("ar")).toBeNull();
    expect(regionFromLocaleTag("")).toBeNull();
  });
});

describe("regionFromTimezone", () => {
  test("maps high-volume zones onto curated regions", () => {
    expect(regionFromTimezone("Europe/Amsterdam")).toBe("nl");
    expect(regionFromTimezone("America/Sao_Paulo")).toBe("pt");
    expect(regionFromTimezone("Asia/Seoul")).toBe("ko");
    expect(regionFromTimezone("America/New_York")).toBe("en");
    expect(regionFromTimezone("America/Argentina/Buenos_Aires")).toBe("es");
    expect(regionFromTimezone("Asia/Taipei")).toBe("zh-TW");
  });

  test("ignores weak or empty timezones so language can win", () => {
    expect(regionFromTimezone("UTC")).toBeNull();
    expect(regionFromTimezone("Etc/UTC")).toBeNull();
    expect(regionFromTimezone("")).toBeNull();
  });
});

describe("resolveNamingRegion", () => {
  test("prefers timezone when language and timezone disagree", () => {
    const resolution = resolveNamingRegion({
      locales: ["en-US"],
      timezone: "Europe/Amsterdam",
    });

    expect(resolution).toEqual({
      region: "nl",
      signal: "timezone",
      localeRegion: "en",
      timezoneRegion: "nl",
    });
  });

  test("an English timezone beats a non-English browser language", () => {
    const resolution = resolveNamingRegion({
      locales: ["nl-NL"],
      timezone: "America/New_York",
    });

    expect(resolution.region).toBe("en");
    expect(resolution.signal).toBe("timezone");
  });

  test("uses language when the timezone is weak or unknown", () => {
    expect(
      resolveNamingRegion({ locales: ["ko-KR"], timezone: "UTC" }),
    ).toMatchObject({ region: "ko", signal: "locale" });
    expect(
      resolveNamingRegion({
        locales: ["pt-BR"],
        timezone: "Asia/Dubai",
      }),
    ).toMatchObject({ region: "pt", signal: "locale" });
  });

  test("records agreement when both signals name the same region", () => {
    expect(
      resolveNamingRegion({
        locales: ["nl-NL"],
        timezone: "Europe/Amsterdam",
      }),
    ).toMatchObject({ region: "nl", signal: "agree" });
  });

  test("falls back to English when neither signal maps", () => {
    expect(
      resolveNamingRegion({ locales: ["ar"], timezone: "UTC" }),
    ).toMatchObject({ region: "en", signal: "fallback" });
  });
});

describe("assistant name pools", () => {
  test("every region keeps all four personality groups with unique names", () => {
    for (const region of NAMING_REGIONS) {
      const groups = namesForRegion(region);
      const names = allNamesForRegion(region);
      expect(PERSONALITY_GROUP_IDS.every((id) => groups[id].length === 6)).toBe(
        true,
      );
      expect(names).toHaveLength(24);
      expect(new Set(names).size).toBe(24);
    }
  });

  test("surprise-me pick uses the locale-fitting pool, not a global Ziggy", () => {
    const dutch = pickAssistantName(
      { locales: ["en-US"], timezone: "Europe/Amsterdam" },
      { random: () => 0 },
    );
    expect(dutch.pool.region).toBe("nl");
    expect(dutch.name).toBe("Bram");
    expect(allNamesForRegion("nl")).toContain(dutch.name);
    expect(dutch.name).not.toBe("Ziggy");

    const english = pickAssistantName(
      { locales: ["en-US"], timezone: "America/New_York" },
      { random: () => 0 },
    );
    expect(english.pool.region).toBe("en");
    expect(english.name).toBe("Penn");
  });

  test("Seoul and São Paulo resolve to their own pools", () => {
    expect(
      resolveAssistantNamePool({
        locales: ["en-US"],
        timezone: "Asia/Seoul",
      }).names,
    ).toEqual(allNamesForRegion("ko"));
    expect(
      resolveAssistantNamePool({
        locales: ["en-GB"],
        timezone: "America/Sao_Paulo",
      }).region,
    ).toBe("pt");
  });

  test("sampleSuggestionNames stays six unique names from the locale pool", () => {
    const sampled = sampleSuggestionNames(
      { locales: ["nl"], timezone: "UTC" },
      () => 0,
    );
    expect(sampled).toHaveLength(6);
    expect(new Set(sampled).size).toBe(6);
    const dutch = new Set(allNamesForRegion("nl"));
    expect(sampled.every((name) => dutch.has(name))).toBe(true);
  });

  test("formats the naming-step funnel screen as source:region:signal", () => {
    expect(
      formatNamingFunnelScreen({
        source: "surprise_me",
        region: "nl",
        signal: "timezone",
      }),
    ).toBe("surprise_me:nl:timezone");
  });
});
