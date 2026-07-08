import { describe, expect, test } from "bun:test";

import { PREFIX_PATTERNS } from "../security/secret-patterns.js";

function matchingLabels(text: string): string[] {
  return PREFIX_PATTERNS.filter((p) => p.regex.test(text)).map((p) => p.label);
}

describe("Vercel AI Gateway API Key", () => {
  test("matches a vck_ key as exactly one pattern", () => {
    expect(matchingLabels(`vck_${"a".repeat(32)}`)).toEqual([
      "Vercel AI Gateway API Key",
    ]);
  });

  test("does not match a short vck_ string", () => {
    expect(matchingLabels("vck_abc")).toEqual([]);
  });
});

describe("OpenRouter API Key", () => {
  test("matches an sk-or-v1- key", () => {
    expect(matchingLabels(`sk-or-v1-${"a".repeat(40)}`)).toEqual([
      "OpenRouter API Key",
    ]);
  });
});
