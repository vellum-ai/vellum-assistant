import { describe, expect, test } from "bun:test";

import {
  normalizeTitle,
  stripMarkdown,
  stripThinkingTags,
  truncateTitle,
} from "../short-title.js";

/** The character and word budgets `short-title.ts` documents and enforces. */
const MAX_TITLE_LENGTH = 40;
const MAX_TITLE_WORDS = 7;

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

  test("still honors the char limit when the first five words overflow it", () => {
    const title =
      "Authentication Infrastructure Modernization Deployment Verification Report Complete Today";
    expect(title.length).toBeGreaterThan(MAX_TITLE_LENGTH);
    expect(title.split(" ").length).toBeGreaterThan(MAX_TITLE_WORDS);
    const result = truncateTitle(title);
    expect(result).toBe("Authentication Infrastructure");
    expect(result.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
  });
});

describe("normalizeTitle prose rejection", () => {
  test("rejects multi-line output", () => {
    expect(normalizeTitle("Auth Rewrite\nand more")).toBe("");
  });

  test("rejects embedded transcript markers", () => {
    expect(normalizeTitle("User: how do I log in")).toBe("");
    expect(normalizeTitle("Assistant : here you go")).toBe("");
  });

  test("rejects sentence-shaped clauses ending in terminal punctuation", () => {
    expect(normalizeTitle("This is a topic about authentication.")).toBe("");
    expect(normalizeTitle("What did they want to build here?")).toBe("");
  });

  test("keeps short phrases that end in punctuation", () => {
    expect(normalizeTitle("Auth Rewrite?")).toBe("Auth Rewrite?");
  });

  test("rejects first-person reasoning openers", () => {
    expect(normalizeTitle("I need to generate a title")).toBe("");
    expect(normalizeTitle("I'll work through these files")).toBe("");
    expect(normalizeTitle("I cannot title this")).toBe("");
  });

  test("rejects imperative and deferral openers", () => {
    expect(normalizeTitle("Let me summarize the request")).toBe("");
    expect(normalizeTitle("Looking at the conversation")).toBe("");
    expect(normalizeTitle("Based on the messages")).toBe("");
    expect(normalizeTitle("Given the context")).toBe("");
  });

  test("rejects infinitive openers", () => {
    expect(normalizeTitle("To generate a good title")).toBe("");
    expect(normalizeTitle("To summarize the discussion")).toBe("");
    expect(normalizeTitle("To title this thread")).toBe("");
  });

  test("rejects subject-led reasoning openers", () => {
    expect(normalizeTitle("The user wants a summary")).toBe("");
    expect(normalizeTitle("The conversation is about Docker")).toBe("");
    expect(normalizeTitle("The assistant should reply")).toBe("");
    expect(normalizeTitle("The title should be short")).toBe("");
  });

  test("rejects preamble openers", () => {
    expect(normalizeTitle("Here's a title")).toBe("");
    expect(normalizeTitle("Here is a title")).toBe("");
    expect(normalizeTitle("Here are the options")).toBe("");
    expect(normalizeTitle("Sure, Auth Rewrite")).toBe("");
    expect(normalizeTitle("Okay, Auth Rewrite")).toBe("");
    expect(normalizeTitle("Ok, Auth Rewrite")).toBe("");
  });

  test("accepts bare noun-phrase titles that share a subject word", () => {
    expect(normalizeTitle("The Conversation API")).toBe("The Conversation API");
    expect(normalizeTitle("The User Interface Redesign")).toBe(
      "The User Interface Redesign",
    );
    expect(normalizeTitle("Auth Middleware Rewrite")).toBe(
      "Auth Middleware Rewrite",
    );
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
    const metaFailures = [
      "missing context",
      "no context",
      "insufficient context",
      "unclear context",
      "empty context",
      "no topic",
      "unclear topic",
      "unclear request",
      "unclear message",
      "empty conversation",
      "empty message",
      "no content",
    ];
    for (const meta of metaFailures) {
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

  test("keeps a wordy title inside the character budget", () => {
    const result = normalizeTitle(
      "Authentication Infrastructure Modernization Deployment Verification Report Complete Today",
    );
    expect(result).toBe("Authentication Infrastructure");
    expect(result.length).toBeLessThanOrEqual(MAX_TITLE_LENGTH);
  });
});
