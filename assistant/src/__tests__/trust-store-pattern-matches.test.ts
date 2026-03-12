import { describe, expect, test } from "bun:test";

import { patternMatchesCandidate } from "../permissions/trust-store.js";

describe("patternMatchesCandidate", () => {
  test("exact match", () => {
    expect(patternMatchesCandidate("bash:git commit", "bash:git commit")).toBe(
      true,
    );
  });

  test("glob match", () => {
    expect(patternMatchesCandidate("bash:git *", "bash:git commit")).toBe(true);
  });

  test("no match", () => {
    expect(patternMatchesCandidate("bash:git *", "file_write:/foo")).toBe(
      false,
    );
  });

  test("globstar matches anything", () => {
    expect(patternMatchesCandidate("**", "bash:anything")).toBe(true);
  });

  test("invalid pattern returns false", () => {
    expect(patternMatchesCandidate("[", "bash:anything")).toBe(false);
  });
});
