import { describe, expect, test } from "bun:test";

import {
  buildSkillsSearchParams,
  readSkillsUrlState,
} from "@/domains/intelligence/skills/skills-url-state";

describe("readSkillsUrlState", () => {
  test("empty params resolve to the defaults", () => {
    expect(readSkillsUrlState(new URLSearchParams())).toEqual({
      q: "",
      filter: "all",
      category: null,
    });
  });

  test("reads q, filter, and category from the params", () => {
    const params = new URLSearchParams(
      "?q=git&filter=installed&category=email",
    );
    expect(readSkillsUrlState(params)).toEqual({
      q: "git",
      filter: "installed",
      category: "email",
    });
  });

  test("an unknown filter value falls back to 'all'", () => {
    const params = new URLSearchParams("?filter=bogus");
    expect(readSkillsUrlState(params).filter).toBe("all");
  });

  test("an empty category param reads as null", () => {
    const params = new URLSearchParams("?category=");
    expect(readSkillsUrlState(params).category).toBeNull();
  });
});

describe("buildSkillsSearchParams", () => {
  test("omits defaults so the plain URL stays clean", () => {
    const next = buildSkillsSearchParams(new URLSearchParams(), {
      q: "",
      filter: "all",
      category: null,
    });
    expect(next.toString()).toBe("");
  });

  test("sets non-default values", () => {
    const next = buildSkillsSearchParams(new URLSearchParams(), {
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
    const next = buildSkillsSearchParams(params, {
      q: "",
      filter: "all",
      category: null,
    });
    expect(next.toString()).toBe("");
  });

  test("leaves keys absent from the update untouched", () => {
    const params = new URLSearchParams("?q=git&filter=installed");
    const next = buildSkillsSearchParams(params, { category: "email" });
    expect(next.get("q")).toBe("git");
    expect(next.get("filter")).toBe("installed");
    expect(next.get("category")).toBe("email");
  });

  test("preserves unrelated params", () => {
    const params = new URLSearchParams("?other=1");
    const next = buildSkillsSearchParams(params, { q: "git" });
    expect(next.get("other")).toBe("1");
    expect(next.get("q")).toBe("git");
  });

  test("whitespace-only search is treated as empty", () => {
    const params = new URLSearchParams("?q=git");
    const next = buildSkillsSearchParams(params, { q: "   " });
    expect(next.has("q")).toBe(false);
  });

  test("round-trips through readSkillsUrlState", () => {
    const next = buildSkillsSearchParams(new URLSearchParams(), {
      q: "memory",
      filter: "assistant-memory",
      category: "productivity",
    });
    expect(readSkillsUrlState(next)).toEqual({
      q: "memory",
      filter: "assistant-memory",
      category: "productivity",
    });
  });
});
