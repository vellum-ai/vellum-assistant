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
  const section = (
    title: string,
    dims: { occurrence?: number; chunk?: number } = {},
  ): Section => ({
    article: "page-a",
    title,
    text: "",
    ordinal: 4,
    ...(dims.occurrence === undefined ? {} : { occurrence: dims.occurrence }),
    ...(dims.chunk === undefined ? {} : { chunk: dims.chunk }),
  });

  test("the lead keys as the empty string; a heading keys as its trimmed title", () => {
    expect(sectionKey(section(""))).toBe("");
    expect(sectionKey(section("  Notes "))).toBe("Notes");
  });

  test("a repeated heading appends #<occurrence>; a chunk appends ~<chunk>; both compose", () => {
    expect(sectionKey(section("Notes", { occurrence: 0, chunk: 0 }))).toBe(
      "Notes",
    );
    expect(sectionKey(section("Notes", { occurrence: 2 }))).toBe("Notes#2");
    expect(sectionKey(section("Notes", { chunk: 1 }))).toBe("Notes~1");
    expect(sectionKey(section("Notes", { occurrence: 1, chunk: 3 }))).toBe(
      "Notes#1~3",
    );
    // A long lead chunks too.
    expect(sectionKey(section("", { chunk: 1 }))).toBe("~1");
  });

  test("a literal # or ~ in a title is doubled so no heading can collide with a repeat's or a chunk's key", () => {
    // `## Topic#1` (first of its kind) versus a second `## Topic`.
    expect(sectionKey(section("Topic#1"))).toBe("Topic##1");
    expect(sectionKey(section("Topic", { occurrence: 1 }))).toBe("Topic#1");
    // `## Topic~1` versus the second chunk of `## Topic`.
    expect(sectionKey(section("Topic~1"))).toBe("Topic~~1");
    expect(sectionKey(section("Topic", { chunk: 1 }))).toBe("Topic~1");
    expect(sectionKey(section("Topic#1", { occurrence: 1, chunk: 1 }))).toBe(
      "Topic##1#1~1",
    );
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
      "a~1",
      "x~",
      "~",
      "~~",
      "x#1~2",
      "5",
    ];
    for (const title of titles) {
      for (const occurrence of [undefined, 1, 12]) {
        for (const chunk of [undefined, 1, 3]) {
          const s = section(title, { occurrence, chunk });
          expect(sectionKeyTitle(sectionKey(s))).toBe(title);
        }
      }
    }
    // Keys that differ decode to different (title, occurrence, chunk) triples.
    expect(sectionKeyTitle("Topic##1")).toBe("Topic#1");
    expect(sectionKeyTitle("Topic#1")).toBe("Topic");
    expect(sectionKeyTitle("Topic~~1")).toBe("Topic~1");
    expect(sectionKeyTitle("Topic~1")).toBe("Topic");
    expect(sectionKeyTitle("Topic##1#1~1")).toBe("Topic#1");
  });
});
