import { describe, expect, test } from "bun:test";

import { ancestorPaths, normalizeDeepLinkPath } from "./deep-link";

describe("normalizeDeepLinkPath", () => {
  test("returns null for absent or empty values", () => {
    expect(normalizeDeepLinkPath(null)).toBeNull();
    expect(normalizeDeepLinkPath("")).toBeNull();
    expect(normalizeDeepLinkPath("   ")).toBeNull();
    expect(normalizeDeepLinkPath("/")).toBeNull();
    expect(normalizeDeepLinkPath("///")).toBeNull();
  });

  test("strips surrounding whitespace and leading/trailing slashes", () => {
    expect(normalizeDeepLinkPath("scratch/foo")).toBe("scratch/foo");
    expect(normalizeDeepLinkPath("/scratch/foo/")).toBe("scratch/foo");
    expect(normalizeDeepLinkPath("  scratch/foo  ")).toBe("scratch/foo");
    expect(normalizeDeepLinkPath("scratch/foo.md")).toBe("scratch/foo.md");
  });
});

describe("ancestorPaths", () => {
  test("returns every ancestor prefix plus the path itself, shallowest-first", () => {
    expect(ancestorPaths("a/b/c")).toEqual(["a", "a/b", "a/b/c"]);
  });

  test("single segment yields just that segment", () => {
    expect(ancestorPaths("scratch")).toEqual(["scratch"]);
  });

  test("empty path yields no prefixes", () => {
    expect(ancestorPaths("")).toEqual([]);
  });

  test("ignores empty interior segments from stray slashes", () => {
    expect(ancestorPaths("a//b")).toEqual(["a", "a/b"]);
  });
});
