/**
 * The overview's bento cards draw a countable stat as two elements: the hero
 * numeral (`IdentitySectionStat.value`) and, under it, a small unit label
 * (`IdentitySectionStat.label`). The mini tile joins the same two as
 * `${value} ${label}`. Either way the card supplies the number, so a unit
 * label that also spells the count (`# memories`) shows it twice: "34 34
 * memories".
 *
 * `catalogs.test.ts` proves these messages parse and keep their placeholders;
 * a `#` inside a plural branch passes both. This asserts the rendered label
 * for every unit-label key, in every locale, never contains the count.
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

describe("identity section unit labels", () => {
  for (const locale of SUPPORTED_LOCALES) {
    for (const key of UNIT_LABEL_KEYS) {
      test(`${locale}/${key}: names the unit without repeating the count`, () => {
        const message = lookup(CATALOGS[locale].intelligence, key);
        // A missing translation falls back to English, which is checked on
        // its own pass.
        if (message === undefined) {
          return;
        }
        for (const count of COUNTS) {
          const rendered = String(
            new IntlMessageFormat(message, locale).format({ count }),
          );
          expect(
            rendered,
            `${locale}/${key} at count=${count} rendered "${rendered}"`,
          ).not.toContain(String(count));
        }
      });
    }
  }

  test("en: the Memory card's unit label reads memory / memories", () => {
    const message = lookup(
      CATALOGS.en.intelligence,
      "identityOverview.memoryCountLabel",
    );
    if (message === undefined) {
      throw new Error(
        "en catalog is missing identityOverview.memoryCountLabel",
      );
    }
    const label = (count: number) =>
      String(new IntlMessageFormat(message, "en").format({ count }));
    expect(label(1)).toBe("memory");
    expect(label(34)).toBe("memories");
  });
});
