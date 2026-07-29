import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { DEEPGRAM_MULTI_LANGUAGE_CODES } from "../providers/speech-to-text/deepgram.js";

/**
 * The daemon owns the curated spoken-language roster in
 * `DEEPGRAM_MULTI_LANGUAGE_CODES` (nova-3's `multi` code-switching roster);
 * the settings skill derives its valid set from it. The web settings catalog
 * (`clients/web/src/lib/stt/language-catalog.ts`) holds a second copy for its
 * pickers. Copies drift silently, and a stale catalog would offer a language
 * the daemon rejects (or hide one it accepts), so pin the two together here
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

// The catalog's literal `code: "xx"` entries. The English-default and
// Multilingual rows reference the sentinel constants instead of literals, so
// this yields exactly the monolingual, non-default codes.
const webMonolingualCodes = [
  ...arrayTextAfter(
    WEB_CATALOG_SOURCE,
    "export const STT_LANGUAGES: readonly SttLanguageOption[] = [",
  ).matchAll(/code:\s*"([^"]+)"/g),
].map((m) => m[1]);

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
    // expected monolingual set.
    const expected = DEEPGRAM_MULTI_LANGUAGE_CODES.filter(
      (code) => code !== "en",
    ).sort();
    expect([...webMonolingualCodes].sort()).toEqual(expected);
  });

  test("the catalog never lists a code the daemon roster lacks", () => {
    const daemonCodes: readonly string[] = DEEPGRAM_MULTI_LANGUAGE_CODES;
    expect(
      webMonolingualCodes.filter((code) => !daemonCodes.includes(code)),
    ).toEqual([]);
  });
});
