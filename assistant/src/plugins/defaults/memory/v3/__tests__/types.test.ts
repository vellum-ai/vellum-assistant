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

  test("a literal # in a title is doubled so a heading ending in #<n> never collides with a repeated heading", () => {
    // `## Topic#1` (first of its kind) versus a second `## Topic`.
    expect(sectionKey(section("Topic#1"))).toBe("Topic##1");
    expect(sectionKey(section("Topic", 1))).toBe("Topic#1");
    expect(sectionKey(section("Topic#1", 1))).toBe("Topic##1#1");
    expect(sectionKey(section("Issue #12"))).toBe("Issue ##12");
  });

  test("sectionKeyTitle is the exact inverse of sectionKey", () => {
    const titles = [
      "",
      "Notes",
      "Topic#1",
      "Topic#",
      "#",
      "##",
      "1#",
      "A #1 b",
    ];
    for (const title of titles) {
      for (const titleOrdinal of [undefined, 1, 12]) {
        const s = section(title, titleOrdinal);
        expect(sectionKeyTitle(sectionKey(s))).toBe(title);
      }
    }
    // Keys that differ decode to different (title, occurrence) pairs.
    expect(sectionKeyTitle("Topic##1")).toBe("Topic#1");
    expect(sectionKeyTitle("Topic#1")).toBe("Topic");
    expect(sectionKeyTitle("Topic##1#1")).toBe("Topic#1");
  });
});
