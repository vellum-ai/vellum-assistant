/**
 * Structural guards on the translation catalogs.
 *
 * These do not check translation *quality*. They check the things a translator
 * or a rebase can silently break and that no reviewer reliably catches by eye:
 * a message that no longer parses as ICU, a key that outlived the code that
 * read it, a placeholder dropped in translation (which renders as a literal
 * `{count}` in front of the user), and a key nothing references any more.
 *
 * Missing keys are deliberately *not* an error: `fallbackLng` renders the
 * English copy, so a catalog that lags the source is degraded, not broken.
 */
import { Glob } from "bun";
import { describe, expect, test } from "bun:test";
import IntlMessageFormat from "intl-messageformat";

import { loadCatalogs, type LocaleCatalogs } from "@/i18n/catalogs";
import { NAMESPACES } from "@/i18n/namespaces";
import { DEFAULT_LOCALE, SUPPORTED_LOCALES } from "@/i18n/supported-locales";

/**
 * Built from the real loader rather than a hand-written map, so adding a
 * locale or a namespace needs no change here and the loader registry itself
 * is under test.
 */
const CATALOGS: Record<string, LocaleCatalogs> = Object.fromEntries(
  await Promise.all(
    SUPPORTED_LOCALES.map(async (locale) => [
      locale,
      await loadCatalogs(locale),
    ]),
  ),
);

/** Flatten a nested catalog to `{ "a.b.c": "message" }`. */
function flatten(value: unknown, prefix = ""): Record<string, string> {
  if (typeof value === "string") {
    return { [prefix]: value };
  }
  if (value === null || typeof value !== "object") {
    throw new Error(`Catalog value at "${prefix}" is not a string or object`);
  }
  const out: Record<string, string> = {};
  for (const [key, child] of Object.entries(value)) {
    Object.assign(out, flatten(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

/**
 * Collect every placeholder name referenced by an ICU message, including the
 * arguments of `plural` / `select` and anything nested inside their branches.
 */
function placeholders(message: string, locale: string): Set<string> {
  const found = new Set<string>();

  const walk = (nodes: unknown): void => {
    if (!Array.isArray(nodes)) {
      return;
    }
    for (const node of nodes) {
      if (node === null || typeof node !== "object") {
        continue;
      }
      const element = node as {
        type?: number;
        value?: unknown;
        options?: Record<string, { value?: unknown }>;
        children?: unknown;
      };
      // Types 1 through 6 are argument-bearing (argument, number, date, time,
      // select, plural); 0 is a literal, 7 is `#`, 8 is a tag.
      if (
        typeof element.type === "number" &&
        element.type >= 1 &&
        element.type <= 6 &&
        typeof element.value === "string"
      ) {
        found.add(element.value);
      }
      if (element.options) {
        for (const option of Object.values(element.options)) {
          walk(option.value);
        }
      }
      if (element.children) {
        walk(element.children);
      }
    }
  };

  walk(new IntlMessageFormat(message, locale).getAst());
  return found;
}

describe("catalog integrity", () => {
  test("every shipped locale loads every namespace", () => {
    for (const locale of SUPPORTED_LOCALES) {
      for (const namespace of NAMESPACES) {
        expect(CATALOGS[locale]?.[namespace]).toBeDefined();
      }
    }
  });

  for (const locale of SUPPORTED_LOCALES) {
    for (const namespace of NAMESPACES) {
      test(`${locale}/${namespace}: every message parses as ICU MessageFormat`, () => {
        for (const [key, message] of Object.entries(
          flatten(CATALOGS[locale][namespace]),
        )) {
          expect(() => new IntlMessageFormat(message, locale)).not.toThrow(
            // Surfaces the offending key in the failure output.
            `${locale}/${namespace}/${key}`,
          );
        }
      });
    }
  }

  for (const locale of SUPPORTED_LOCALES.filter((l) => l !== DEFAULT_LOCALE)) {
    for (const namespace of NAMESPACES) {
      const source = flatten(CATALOGS[DEFAULT_LOCALE][namespace]);
      const translated = flatten(CATALOGS[locale][namespace]);

      test(`${locale}/${namespace}: has no keys absent from ${DEFAULT_LOCALE}`, () => {
        const stale = Object.keys(translated).filter((key) => !(key in source));
        expect(stale).toEqual([]);
      });

      test(`${locale}/${namespace}: preserves every placeholder`, () => {
        for (const [key, message] of Object.entries(translated)) {
          const expected = placeholders(source[key], DEFAULT_LOCALE);
          const actual = placeholders(message, locale);
          for (const name of expected) {
            expect(
              actual.has(name),
              `${locale}/${namespace}/${key} is missing placeholder {${name}}`,
            ).toBe(true);
          }
        }
      });
    }
  }
});

describe("catalog usage", () => {
  /**
   * Source text of every file that could reference a key. Read once and
   * searched as a single string: the check only asks whether a key appears
   * anywhere, so per-file attribution would cost more than it tells us.
   */
  const sources = [...new Glob("src/**/*.{ts,tsx}").scanSync(".")]
    .filter((file) => !file.includes("/i18n/locales/"))
    .map((file) => Bun.file(file).text());

  test("no key in the English catalogs is unreferenced", async () => {
    const haystack = (await Promise.all(sources)).join("\n");

    const orphans: string[] = [];
    for (const namespace of NAMESPACES) {
      for (const key of Object.keys(
        flatten(CATALOGS[DEFAULT_LOCALE][namespace]),
      )) {
        // Both call shapes reach the same message: `t("a.b")` inside a
        // component bound to the namespace, and `t("ns:a.b")` from anywhere.
        if (
          haystack.includes(`"${key}"`) ||
          haystack.includes(`"${namespace}:${key}"`)
        ) {
          continue;
        }
        orphans.push(`${namespace}:${key}`);
      }
    }

    // A key nothing reads is copy a translator will still be paid to
    // translate, and dead weight in every locale's chunk. Delete it, or add
    // the call site it was written for.
    expect(orphans).toEqual([]);
  });
});
