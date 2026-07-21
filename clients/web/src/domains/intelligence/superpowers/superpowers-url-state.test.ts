import { describe, expect, test } from "bun:test";

import {
  buildSuperpowersSearchParams,
  readSuperpowersUrlState,
} from "@/domains/intelligence/superpowers/superpowers-url-state";

describe("readSuperpowersUrlState", () => {
  test("empty params resolve to the defaults", () => {
    expect(readSuperpowersUrlState(new URLSearchParams())).toEqual({
      q: "",
      filter: "all",
      category: null,
    });
  });

  test("reads q, filter, and category from the params", () => {
    const params = new URLSearchParams(
      "?q=git&filter=installed&category=email",
    );
    expect(readSuperpowersUrlState(params)).toEqual({
      q: "git",
      filter: "installed",
      category: "email",
    });
  });

  test("accepts the type filters", () => {
    expect(
      readSuperpowersUrlState(new URLSearchParams("?filter=plugins")).filter,
    ).toBe("plugins");
    expect(
      readSuperpowersUrlState(new URLSearchParams("?filter=skills")).filter,
    ).toBe("skills");
  });

  test("an unknown filter value falls back to 'all'", () => {
    const params = new URLSearchParams("?filter=bogus");
    expect(readSuperpowersUrlState(params).filter).toBe("all");
  });

  test("an empty category param reads as null", () => {
    const params = new URLSearchParams("?category=");
    expect(readSuperpowersUrlState(params).category).toBeNull();
  });
});

describe("buildSuperpowersSearchParams", () => {
  test("omits defaults so the plain URL stays clean", () => {
    const next = buildSuperpowersSearchParams(new URLSearchParams(), {
      q: "",
      filter: "all",
      category: null,
    });
    expect(next.toString()).toBe("");
  });

  test("sets non-default values", () => {
    const next = buildSuperpowersSearchParams(new URLSearchParams(), {
      q: "git",
      filter: "clawhub",
      category: "email",
    });
    expect(next.get("q")).toBe("git");
    expect(next.get("filter")).toBe("clawhub");
    expect(next.get("category")).toBe("email");
  });

  test("resetting a value back to its default removes the param", () => {
    const params = new URLSearchParams("?q=git&filter=installed&category=email");
    const next = buildSuperpowersSearchParams(params, {
      q: "",
      filter: "all",
      category: null,
    });
    expect(next.toString()).toBe("");
  });

  test("leaves keys absent from the update untouched", () => {
    const params = new URLSearchParams("?q=git&filter=installed");
    const next = buildSuperpowersSearchParams(params, { category: "email" });
    expect(next.get("q")).toBe("git");
    expect(next.get("filter")).toBe("installed");
    expect(next.get("category")).toBe("email");
  });

  test("preserves unrelated params", () => {
    const params = new URLSearchParams("?other=1");
    const next = buildSuperpowersSearchParams(params, { q: "git" });
    expect(next.get("other")).toBe("1");
    expect(next.get("q")).toBe("git");
  });

  test("whitespace-only search is treated as empty", () => {
    const params = new URLSearchParams("?q=git");
    const next = buildSuperpowersSearchParams(params, { q: "   " });
    expect(next.has("q")).toBe(false);
  });

  test("round-trips through readSuperpowersUrlState", () => {
    const next = buildSuperpowersSearchParams(new URLSearchParams(), {
      q: "memory",
      filter: "plugins",
      category: "productivity",
    });
    expect(readSuperpowersUrlState(next)).toEqual({
      q: "memory",
      filter: "plugins",
      category: "productivity",
    });
  });
});
