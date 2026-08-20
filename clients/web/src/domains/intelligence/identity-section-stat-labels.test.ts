/**
 * A countable stat on the overview's bento cards has two copy shapes. The
 * full-size card draws the hero numeral (`IdentitySectionStat.value`) with a
 * small unit label under it (`IdentitySectionStat.label`), so the label names
 * the unit only and the card supplies the number. The mini tile renders
 * `IdentitySectionStat.text`, a whole ICU message, so that one carries the
 * count itself.
 *
 * `catalogs.test.ts` proves these messages parse and keep their placeholders;
 * a `#` in the wrong shape passes both. This formats every key of each shape,
 * in every locale, and asserts the count is absent from unit labels and
 * present exactly once in the one-line phrases.
 */
import { describe, expect, test } from "bun:test";
import IntlMessageFormat from "intl-messageformat";

import { loadCatalogs, type LocaleCatalogs } from "@/i18n/catalogs";
import { SUPPORTED_LOCALES } from "@/i18n/supported-locales";

/**
 * Every `intelligence` key read into `IdentitySectionStat.label` next to a
 * `value` (see `use-identity-section-stats.ts` and the Memory card in
 * `components/identity-overview.tsx`).
 */
const UNIT_LABEL_KEYS = [
  "identityOverview.memoryCountLabel",
  "useIdentitySectionStats.activeLabel",
  "useIdentitySectionStats.connectedLabel",
  "useIdentitySectionStats.itemLabel",
  "useIdentitySectionStats.personLabel",
] as const;

/**
 * Every `intelligence` key read into `IdentitySectionStat.text` for a
 * countable stat (same producers as the unit labels).
 */
const COUNT_PHRASE_KEYS = [
  "identityOverview.memoryCount",
  "useIdentitySectionStats.activeCount",
  "useIdentitySectionStats.appAndDocCount",
  "useIdentitySectionStats.appCount",
  "useIdentitySectionStats.connectedCount",
  "useIdentitySectionStats.itemCount",
  "useIdentitySectionStats.personCount",
  "useIdentitySectionStats.skillAndPluginCount",
  "useIdentitySectionStats.skillCount",
] as const;

/** Exercises the `one` and `other` categories and a multi-digit count. */
const COUNTS = [0, 1, 34];

const CATALOGS: Record<string, LocaleCatalogs> = Object.fromEntries(
  await Promise.all(
    SUPPORTED_LOCALES.map(async (locale) => [
      locale,
      await loadCatalogs(locale),
    ]),
  ),
);

function lookup(catalog: unknown, key: string): string | undefined {
  let node: unknown = catalog;
  for (const part of key.split(".")) {
    if (node === null || typeof node !== "object") {
      return undefined;
    }
    node = (node as Record<string, unknown>)[part];
  }
  return typeof node === "string" ? node : undefined;
}

function format(message: string, locale: string, count: number): string {
  return String(new IntlMessageFormat(message, locale).format({ count }));
}

/**
 * The message under `key` rendered at each of `COUNTS`. Empty when the locale
 * has no translation: it then falls back to English, which is checked on its
 * own pass.
 */
function renderings(
  locale: string,
  key: string,
): Array<{ count: number; rendered: string }> {
  const message = lookup(CATALOGS[locale].intelligence, key);
  if (message === undefined) {
    return [];
  }
  return COUNTS.map((count) => ({
    count,
    rendered: format(message, locale, count),
  }));
}

function occurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function requireEnglish(key: string): (count: number) => string {
  const message = lookup(CATALOGS.en.intelligence, key);
  if (message === undefined) {
    throw new Error(`en catalog is missing ${key}`);
  }
  return (count) => format(message, "en", count);
}

describe("identity section unit labels", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of UNIT_LABEL_KEYS) {
      test(`${locale}/${key}: names the unit without repeating the count`, () => {
        for (const { count, rendered } of renderings(locale, key)) {
          expect(
            rendered,
            `${locale}/${key} at count=${count} rendered "${rendered}"`,
          ).not.toContain(String(count));
        }
      });
    }
  }

  test("en: the Memory card's unit label reads memory / memories", () => {
    const label = requireEnglish("identityOverview.memoryCountLabel");
    expect(label(1)).toBe("memory");
    expect(label(34)).toBe("memories");
  });
});

describe("identity section count phrases", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of COUNT_PHRASE_KEYS) {
      test(`${locale}/${key}: states the count exactly once`, () => {
        for (const { count, rendered } of renderings(locale, key)) {
          expect(
            occurrences(rendered, String(count)),
            `${locale}/${key} at count=${count} rendered "${rendered}"`,
          ).toBe(1);
        }
      });
    }
  }

  test("en: the Memory tile reads N memory / N memories", () => {
    const phrase = requireEnglish("identityOverview.memoryCount");
    expect(phrase(1)).toBe("1 memory");
    expect(phrase(34)).toBe("34 memories");
  });
});
