import { describe, expect, test } from "bun:test";

import {
  type MemoryRoutingTurn,
  type Section,
  sectionKey,
  sectionKeyTitle,
  type SelectionSource,
  type Slug,
} from "../types.js";

test("v3 core types instantiate", () => {
  const slug: Slug = "page-123";

  const turnContext: MemoryRoutingTurn = {
    conversationId: "conv-xyz",
    turnNumber: 3,
    currentMessage: "hello",
    recentContext: "prior turns",
  };

  const source: SelectionSource = "needle";

  expect(slug).toBe("page-123");
  expect(turnContext.turnNumber).toBe(3);
  expect(source).toBe("needle");
});

describe("sectionKey", () => {
  const section = (title: string, titleOrdinal?: number): Section => ({
    article: "page-a",
    title,
    text: "",
    ordinal: 4,
    ...(titleOrdinal === undefined ? {} : { titleOrdinal }),
  });

  test("the lead keys as the empty string regardless of ordinal", () => {
    expect(sectionKey(section(""))).toBe("");
  });

  test("a heading keys as its trimmed title", () => {
    expect(sectionKey(section("  Notes "))).toBe("Notes");
  });

  test("later sections sharing a title append #<titleOrdinal>", () => {
    expect(sectionKey(section("Notes", 0))).toBe("Notes");
    expect(sectionKey(section("Notes", 2))).toBe("Notes#2");
    expect(sectionKey(section("", 1))).toBe("#1");
  });

  test("sectionKeyTitle strips the chunk suffix back to the title", () => {
    for (const s of [
      section(""),
      section("Notes"),
      section("Notes", 2),
      section("", 1),
    ]) {
      expect(sectionKeyTitle(sectionKey(s))).toBe(s.title);
    }
    // The strip is mechanical: a heading that itself ends in `#<n>` loses
    // that tail too, which is why key consumers try the full key as a title
    // before the stripped one.
    expect(sectionKeyTitle("Issue #12")).toBe("Issue ");
  });
});
