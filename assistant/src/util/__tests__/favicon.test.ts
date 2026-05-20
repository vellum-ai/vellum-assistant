import { describe, expect, test } from "bun:test";

import { faviconUrlForDomain } from "../favicon.js";

describe("faviconUrlForDomain", () => {
  test("returns a properly encoded s2 URL for a valid host", () => {
    expect(faviconUrlForDomain("example.com")).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    );
  });

  test("lowercases mixed-case hosts before encoding", () => {
    expect(faviconUrlForDomain("Example.COM")).toBe(
      "https://www.google.com/s2/favicons?domain=example.com&sz=64",
    );
  });

  test("returns undefined for empty input", () => {
    expect(faviconUrlForDomain("")).toBeUndefined();
  });

  test("returns undefined for whitespace-only input", () => {
    expect(faviconUrlForDomain("   ")).toBeUndefined();
  });

  test("returns undefined for hosts containing a slash", () => {
    expect(faviconUrlForDomain("example.com/path")).toBeUndefined();
  });

  test("returns undefined for hosts containing a space", () => {
    expect(faviconUrlForDomain("example .com")).toBeUndefined();
  });

  test("URL-encodes unicode/IDN hosts", () => {
    // Punycode-style raw unicode host should be percent-encoded by encodeURIComponent.
    const result = faviconUrlForDomain("münchen.de");
    expect(result).toBe(
      `https://www.google.com/s2/favicons?domain=${encodeURIComponent("münchen.de")}&sz=64`,
    );
    // Sanity check: the encoded form contains percent-encoded bytes for "ü".
    expect(result).toContain("m%C3%BCnchen.de");
  });
});
