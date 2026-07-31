import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import {
  DEEPGRAM_MULTI_LANGUAGE_CODES,
  DEEPGRAM_NOVA3_MONOLINGUAL_CODES,
} from "../providers/speech-to-text/deepgram.js";

/**
 * The daemon owns the curated spoken-language roster in
 * `DEEPGRAM_NOVA3_MONOLINGUAL_CODES` (the verified nova-3 monolingual
 * roster); the settings skill derives its valid set from it. The web
 * settings catalog (`clients/web/src/lib/stt/language-catalog.ts`) holds a
 * second copy for its pickers, split into the `multi` code-switching roster
 * (offered everywhere) and `extended` entries (nova-3 providers only).
 * Copies drift silently, and a stale catalog would offer a language the
 * daemon rejects (or hide one it accepts), so pin the two together here
 * rather than trusting comments to hold the line. Mirrors the pattern in
 * `slack-required-scopes-mirror.test.ts` (that check cannot live in the web
 * package alone: web tests cannot see this package's roster).
 */
const REPO_ROOT = join(import.meta.dir, "..", "..", "..");

const WEB_CATALOG_SOURCE = readFileSync(
  join(REPO_ROOT, "clients/web/src/lib/stt/language-catalog.ts"),
  "utf-8",
);

/** Pull the text of the array literal introduced by `opener`. */
function arrayTextAfter(source: string, opener: string): string {
  const start = source.indexOf(opener);
  if (start === -1) {
    throw new Error(`Not found: ${opener}`);
  }
  const from = start + opener.length;
  const end = source.indexOf("];", from);
  if (end === -1) {
    throw new Error(`Unterminated array after: ${opener}`);
  }
  return source.slice(from, end);
}

/** Value of a string-constant export, e.g. `export const FOO = "bar";`. */
function stringConstant(source: string, name: string): string {
  const match = source.match(
    new RegExp(`export const ${name}\\s*=\\s*"([^"]*)"`),
  );
  if (!match) {
    throw new Error(`Not found: export const ${name}`);
  }
  return match[1];
}

// The catalog's entries are flat object literals; the English-default and
// Multilingual rows reference the sentinel constants instead of `code`
// string literals, so parsing per-object and keeping only literal codes
// yields exactly the monolingual entries, with their `extended` marker.
const webMonolingualEntries = [
  ...arrayTextAfter(
    WEB_CATALOG_SOURCE,
    "export const STT_LANGUAGES: readonly SttLanguageOption[] = [",
  ).matchAll(/\{[^}]*\}/g),
]
  .map((m) => m[0])
  .flatMap((objectText) => {
    const code = objectText.match(/code:\s*"([^"]+)"/);
    if (!code) {
      return [];
    }
    return [{ code: code[1], extended: /extended:\s*true/.test(objectText) }];
  });

const webMonolingualCodes = webMonolingualEntries.map((entry) => entry.code);

const webMultiCode = stringConstant(WEB_CATALOG_SOURCE, "STT_MULTI_CODE");
const webDefaultCode = stringConstant(
  WEB_CATALOG_SOURCE,
  "STT_LANGUAGE_DEFAULT_CODE",
);

describe("web STT language catalog stays in sync with the daemon roster", () => {
  test("the catalog source parses into a usable code list", () => {
    expect(webMonolingualCodes.length).toBeGreaterThan(0);
    // No duplicates: a duplicate entry would mask a drift below.
    expect(new Set(webMonolingualCodes).size).toBe(webMonolingualCodes.length);
  });

  test("the sentinel constants carry the values the daemon expects", () => {
    // "multi" is the code the daemon's adapters special-case (nova-3 pin on
    // Deepgram, dropped for xAI); the default sentinel must stay the empty
    // string, meaning "unset / provider default (English)".
    expect(webMultiCode).toBe("multi");
    expect(webDefaultCode).toBe("");
  });

  test("the catalog offers exactly the daemon roster (English via the default row)", () => {
    // The web catalog represents English with the default sentinel row rather
    // than a literal "en" entry, so the daemon roster minus "en" is the
    // expected monolingual set. A code added on either side alone fails here.
    const expected = DEEPGRAM_NOVA3_MONOLINGUAL_CODES.filter(
      (code) => code !== "en",
    ).sort();
    expect([...webMonolingualCodes].sort()).toEqual(expected);
  });

  test("the multi code-switching roster is a subset of the monolingual roster", () => {
    // "multi" is a mode of nova-3, so every language it can switch between
    // must also be offered monolingually.
    const monolingual: readonly string[] = DEEPGRAM_NOVA3_MONOLINGUAL_CODES;
    expect(
      DEEPGRAM_MULTI_LANGUAGE_CODES.filter(
        (code) => !monolingual.includes(code),
      ),
    ).toEqual([]);
  });

  test("the catalog's non-extended entries are exactly the multi roster", () => {
    // Entries without `extended: true` are what non-nova-3 providers (xai)
    // are offered, and what the Multilingual description enumerates: pinned
    // to the daemon's multi roster so neither side can drift alone.
    const expected = DEEPGRAM_MULTI_LANGUAGE_CODES.filter(
      (code) => code !== "en",
    ).sort();
    const nonExtended = webMonolingualEntries
      .filter((entry) => !entry.extended)
      .map((entry) => entry.code)
      .sort();
    expect(nonExtended).toEqual(expected);
  });
});
