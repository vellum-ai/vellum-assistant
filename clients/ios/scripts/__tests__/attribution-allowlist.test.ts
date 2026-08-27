/**
 * Drift guard for the marketing attribution allowlist.
 *
 * `ATTRIBUTION_PARAMS` and `ATTRIBUTION_VALUE_MAX_LENGTH` in
 * `clients/web/src/domains/account/social-auth.ts` are the source of truth for
 * which campaign params reach the platform and how long each may be. Neither
 * Swift nor Java can import TypeScript, so both native shells embed the list
 * verbatim: `Attribution` in `clients/ios/App/App/Attribution.swift` and
 * `Attribution` in
 * `clients/android/app/src/main/java/ai/vellum/assistant/Attribution.java`.
 * Without this test, a key added to the web contract would leave CI green
 * while both shells silently dropped it.
 *
 * The TypeScript constants are read as source text rather than imported:
 * `social-auth.ts` reaches `@/generated/...` through a CSRF helper, and that
 * path alias has no tsconfig to resolve against from `clients/ios`, which is
 * where the workflow runs `bun test`. Parsing all three files the same way
 * keeps the comparison symmetric, and every extractor throws rather than
 * yielding an empty list when a file stops matching its expected shape.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "../../../..");

const SOURCES = {
  typescript: join(REPO_ROOT, "clients/web/src/domains/account/social-auth.ts"),
  swift: join(REPO_ROOT, "clients/ios/App/App/Attribution.swift"),
  java: join(
    REPO_ROOT,
    "clients/android/app/src/main/java/ai/vellum/assistant/Attribution.java",
  ),
} as const;

type Language = keyof typeof SOURCES;

/** Declaration opener through the literal's body, captured in group 1. */
const ALLOWLIST_DECLARATIONS: Record<Language, RegExp> = {
  typescript: /\bconst\s+ATTRIBUTION_PARAMS\b[^=]*=\s*\[([^\]]*)\]/,
  swift: /\bstatic\s+let\s+keys\b[^=]*=\s*\[([^\]]*)\]/,
  java: /\bstatic\s+final\s+String\[\]\s+KEYS\s*=\s*\{([^}]*)\}/,
};

const MAX_LENGTH_DECLARATIONS: Record<Language, RegExp> = {
  typescript: /\bconst\s+ATTRIBUTION_VALUE_MAX_LENGTH\b[^=]*=\s*(\d+)/,
  swift: /\bstatic\s+let\s+valueMaxLength\b[^=]*=\s*(\d+)/,
  java: /\bstatic\s+final\s+int\s+VALUE_MAX_LENGTH\s*=\s*(\d+)/,
};

function read(language: Language): string {
  return readFileSync(SOURCES[language], "utf8");
}

function extractAllowlist(language: Language): string[] {
  const body = ALLOWLIST_DECLARATIONS[language].exec(read(language))?.[1];
  if (body === undefined) {
    throw new Error(
      `${SOURCES[language]} does not declare its attribution allowlist in the shape this guard parses`,
    );
  }
  const keys = [...body.matchAll(/"([^"]*)"/g)].map((match) => match[1]);
  if (keys.length === 0) {
    throw new Error(
      `${SOURCES[language]} parsed an empty attribution allowlist`,
    );
  }
  return keys;
}

function extractMaxLength(language: Language): number {
  const value = MAX_LENGTH_DECLARATIONS[language].exec(read(language))?.[1];
  if (value === undefined) {
    throw new Error(
      `${SOURCES[language]} does not declare its attribution truncation length in the shape this guard parses`,
    );
  }
  return Number(value);
}

describe("attribution allowlist", () => {
  const expectedKeys = extractAllowlist("typescript");
  const expectedMaxLength = extractMaxLength("typescript");

  test("the web contract still looks like an allowlist", () => {
    expect(expectedKeys).toContain("utm_source");
    expect(new Set(expectedKeys).size).toBe(expectedKeys.length);
    expect(expectedMaxLength).toBeGreaterThan(0);
  });

  for (const language of ["swift", "java"] as const) {
    test(`the ${language} shell embeds the web allowlist in order`, () => {
      expect(extractAllowlist(language)).toEqual(expectedKeys);
    });

    test(`the ${language} shell truncates at the web length`, () => {
      expect(extractMaxLength(language)).toBe(expectedMaxLength);
    });
  }
});
