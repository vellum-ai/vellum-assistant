import { describe, expect, test } from "bun:test";

import {
  LEAKED_PROSE_PREFIXES,
  looksLikeLeakedProse,
  MAX_TITLE_LENGTH,
  MAX_TITLE_WORDS,
  META_FAILURE_TITLES,
  normalizeTitle,
  stripMarkdown,
  stripThinkingTags,
  truncateTitle,
} from "../short-title.js";

describe("stripMarkdown", () => {
  test("unwraps bold, italic, strikethrough, and code spans", () => {
    expect(stripMarkdown("**Auth** Rewrite")).toBe("Auth Rewrite");
    expect(stripMarkdown("__Auth__ Rewrite")).toBe("Auth Rewrite");
    expect(stripMarkdown("*Auth* Rewrite")).toBe("Auth Rewrite");
    expect(stripMarkdown("_Auth_ Rewrite")).toBe("Auth Rewrite");
    expect(stripMarkdown("~~Auth~~ Rewrite")).toBe("Auth Rewrite");
    expect(stripMarkdown("`Auth` Rewrite")).toBe("Auth Rewrite");
  });

  test("keeps link text and drops the target", () => {
    expect(stripMarkdown("[Auth Rewrite](https://example.com)")).toBe(
      "Auth Rewrite",
    );
  });

  test("removes heading markers", () => {
    expect(stripMarkdown("## Auth Rewrite")).toBe("Auth Rewrite");
  });

  test("preserves snake_case identifiers", () => {
    expect(stripMarkdown("record_conversation_title")).toBe(
      "record_conversation_title",
    );
  });
});

describe("stripThinkingTags", () => {
  test("removes paired thinking blocks and their contents", () => {
    expect(stripThinkingTags("<thinking>hmm</thinking>Auth Rewrite")).toBe(
      "Auth Rewrite",
    );
    expect(stripThinkingTags("<thought>hmm</thought>Auth Rewrite")).toBe(
      "Auth Rewrite",
    );
    expect(stripThinkingTags("<think>hmm</think>Auth Rewrite")).toBe(
      "Auth Rewrite",
    );
  });

  test("removes unpaired tags but keeps the surrounding text", () => {
    expect(stripThinkingTags("<thinking>Auth Rewrite")).toBe("Auth Rewrite");
    expect(stripThinkingTags("Auth Rewrite</think>")).toBe("Auth Rewrite");
  });

  test("removes colon-prefixed pseudo tags", () => {
    expect(stripThinkingTags("<:anything>Auth Rewrite")).toBe("Auth Rewrite");
  });

  test("leaves plain text untouched", () => {
    expect(stripThinkingTags("Auth Rewrite")).toBe("Auth Rewrite");
  });
});

describe("truncateTitle", () => {
  test("leaves titles within the character limit untouched", () => {
    const title = "Auth Middleware Rewrite";
    expect(title.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
    expect(truncateTitle(title)).toBe(title);
  });

  test("trims at a word boundary when few but long words exceed the char limit", () => {
    const title = "Supercalifragilistic Authentication Middleware Rewrite";
    expect(title.split(" ").length).toBeLessThanOrEqual(MAX_TITLE_WORDS);
    expect(truncateTitle(title)).toBe("Supercalifragilistic Authentication");
  });

  test("hard-slices a single word longer than the char limit", () => {
    const title = "a".repeat(MAX_TITLE_LENGTH + 5);
    expect(truncateTitle(title)).toBe("a".repeat(MAX_TITLE_LENGTH));
  });

  test("keeps the first five words when the word limit is exceeded", () => {
    const title =
      "alpha bravo charlie delta echo foxtrot golf hotel india juliet";
    expect(title.length).toBeGreaterThan(MAX_TITLE_LENGTH);
    expect(title.split(" ").length).toBeGreaterThan(MAX_TITLE_WORDS);
    expect(truncateTitle(title)).toBe("alpha bravo charlie delta echo");
  });
});

describe("looksLikeLeakedProse", () => {
  test("rejects multi-line output", () => {
    expect(looksLikeLeakedProse("Auth Rewrite\nand more")).toBe(true);
  });

  test("rejects embedded transcript markers", () => {
    expect(looksLikeLeakedProse("User: how do I log in")).toBe(true);
    expect(looksLikeLeakedProse("Assistant : here you go")).toBe(true);
  });

  test("rejects sentence-shaped clauses ending in terminal punctuation", () => {
    expect(looksLikeLeakedProse("This is a topic about authentication.")).toBe(
      true,
    );
    expect(looksLikeLeakedProse("What did they want to build here?")).toBe(
      true,
    );
  });

  test("keeps short phrases that end in punctuation", () => {
    expect(looksLikeLeakedProse("Auth Rewrite?")).toBe(false);
  });

  test("rejects first-person reasoning openers", () => {
    expect(looksLikeLeakedProse("I need to generate a title")).toBe(true);
    expect(looksLikeLeakedProse("I'll work through these files")).toBe(true);
    expect(looksLikeLeakedProse("I cannot title this")).toBe(true);
  });

  test("rejects imperative and deferral openers", () => {
    expect(looksLikeLeakedProse("Let me summarize the request")).toBe(true);
    expect(looksLikeLeakedProse("Looking at the conversation")).toBe(true);
    expect(looksLikeLeakedProse("Based on the messages")).toBe(true);
    expect(looksLikeLeakedProse("Given the context")).toBe(true);
  });

  test("rejects infinitive openers", () => {
    expect(looksLikeLeakedProse("To generate a good title")).toBe(true);
    expect(looksLikeLeakedProse("To summarize the discussion")).toBe(true);
    expect(looksLikeLeakedProse("To title this thread")).toBe(true);
  });

  test("rejects subject-led reasoning openers", () => {
    expect(looksLikeLeakedProse("The user wants a summary")).toBe(true);
    expect(looksLikeLeakedProse("The conversation is about Docker")).toBe(true);
    expect(looksLikeLeakedProse("The assistant should reply")).toBe(true);
    expect(looksLikeLeakedProse("The title should be short")).toBe(true);
  });

  test("rejects preamble openers", () => {
    expect(looksLikeLeakedProse("Here's a title")).toBe(true);
    expect(looksLikeLeakedProse("Here is a title")).toBe(true);
    expect(looksLikeLeakedProse("Sure, Auth Rewrite")).toBe(true);
    expect(looksLikeLeakedProse("Okay, Auth Rewrite")).toBe(true);
  });

  test("accepts bare noun-phrase titles that share a subject word", () => {
    expect(looksLikeLeakedProse("The Conversation API")).toBe(false);
    expect(looksLikeLeakedProse("The User Interface Redesign")).toBe(false);
    expect(looksLikeLeakedProse("Auth Middleware Rewrite")).toBe(false);
  });

  test("every configured prefix is treated as prose", () => {
    for (const prefix of LEAKED_PROSE_PREFIXES) {
      expect(looksLikeLeakedProse(`${prefix} something`)).toBe(true);
    }
  });
});

describe("normalizeTitle", () => {
  test("strips surrounding quotes", () => {
    expect(normalizeTitle('"Auth Rewrite"')).toBe("Auth Rewrite");
    expect(normalizeTitle("'Auth Rewrite'")).toBe("Auth Rewrite");
  });

  test("strips markdown and thinking tags together", () => {
    expect(normalizeTitle("<thinking>hmm</thinking> **Auth Rewrite**")).toBe(
      "Auth Rewrite",
    );
  });

  test("returns empty for blank input", () => {
    expect(normalizeTitle("")).toBe("");
    expect(normalizeTitle("   ")).toBe("");
    expect(normalizeTitle("<thinking>hmm</thinking>")).toBe("");
  });

  test("returns empty for leaked prose", () => {
    expect(normalizeTitle("I need to generate a title for this")).toBe("");
    expect(normalizeTitle("User: how do I log in")).toBe("");
    expect(normalizeTitle("Auth Rewrite\nand more")).toBe("");
  });

  test("returns empty for meta-failure titles regardless of case", () => {
    for (const meta of META_FAILURE_TITLES) {
      expect(normalizeTitle(meta)).toBe("");
    }
    expect(normalizeTitle("Missing Context")).toBe("");
    expect(normalizeTitle('"No Topic"')).toBe("");
  });

  test("truncates an over-long accepted title", () => {
    expect(
      normalizeTitle("alpha bravo charlie delta echo foxtrot golf hotel india"),
    ).toBe("alpha bravo charlie delta echo");
  });
});
