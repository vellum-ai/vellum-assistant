import { describe, expect, test } from "bun:test";

import { loadableLocales } from "@/i18n/catalogs";
import {
  DEFAULT_LOCALE,
  LOCALE_LABELS,
  SUPPORTED_LOCALES,
  isSupportedLocale,
  negotiateLocale,
} from "@/i18n/supported-locales";

describe("negotiateLocale", () => {
  test("matches an exact tag", () => {
    expect(negotiateLocale(["es"])).toBe("es");
  });

  test("falls back to the primary subtag for a regional variant", () => {
    expect(negotiateLocale(["es-MX"])).toBe("es");
    expect(negotiateLocale(["es-419"])).toBe("es");
    expect(negotiateLocale(["ru-RU"])).toBe("ru");
  });

  test("is case-insensitive", () => {
    expect(negotiateLocale(["ES-mx"])).toBe("es");
  });

  test("honors preference order over specificity", () => {
    // `es-MX` is the user's first choice; matching it by primary subtag must
    // win over an exact match on a lower-ranked preference.
    expect(negotiateLocale(["es-MX", "en"])).toBe("es");
  });

  test("skips unsupported tags to reach a supported one", () => {
    expect(negotiateLocale(["fr-CA", "de", "es"])).toBe("es");
  });

  test("returns the default when nothing matches", () => {
    expect(negotiateLocale(["fr", "de-AT"])).toBe(DEFAULT_LOCALE);
  });

  test("returns the default for an empty or blank list", () => {
    expect(negotiateLocale([])).toBe(DEFAULT_LOCALE);
    expect(negotiateLocale(["", "   "])).toBe(DEFAULT_LOCALE);
  });
});

describe("isSupportedLocale", () => {
  test("accepts shipped locales and rejects everything else", () => {
    expect(isSupportedLocale("en")).toBe(true);
    expect(isSupportedLocale("fr")).toBe(false);
    expect(isSupportedLocale("en-US")).toBe(false);
    expect(isSupportedLocale(undefined)).toBe(false);
    expect(isSupportedLocale(42)).toBe(false);
  });
});

describe("locale registry coverage", () => {
  test("every supported locale has a catalog loader", () => {
    expect([...loadableLocales()].sort()).toEqual(
      [...SUPPORTED_LOCALES].sort(),
    );
  });

  test("every supported locale has a display label", () => {
    for (const locale of SUPPORTED_LOCALES) {
      expect(LOCALE_LABELS[locale]).toBeTruthy();
    }
  });

  test("the default locale is one of the supported locales", () => {
    expect(isSupportedLocale(DEFAULT_LOCALE)).toBe(true);
  });
});
