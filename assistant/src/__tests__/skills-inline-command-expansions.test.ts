import { describe, expect, test } from "bun:test";

import { parseInlineCommandExpansions } from "../skills/inline-command-expansions.js";

// ─── Basic parsing ────────────────────────────────────────────────────────────

describe("parseInlineCommandExpansions", () => {
  test("parses a single inline command expansion", () => {
    const body = "Run this: !`gh pr diff`";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(1);
    expect(result.errors).toHaveLength(0);

    const exp = result.expansions[0];
    expect(exp.command).toBe("gh pr diff");
    expect(exp.placeholderId).toBe(0);
    expect(exp.startOffset).toBe(10);
    expect(exp.endOffset).toBe(23);
  });

  test("parses multiple inline command expansions in order", () => {
    const body = "First: !`ls -la` and second: !`echo hello`";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(2);
    expect(result.errors).toHaveLength(0);

    expect(result.expansions[0].command).toBe("ls -la");
    expect(result.expansions[0].placeholderId).toBe(0);

    expect(result.expansions[1].command).toBe("echo hello");
    expect(result.expansions[1].placeholderId).toBe(1);
  });

  test("preserves literal command text including internal spaces", () => {
    const body = "!`git log --oneline -n 10`";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(1);
    expect(result.expansions[0].command).toBe("git log --oneline -n 10");
  });

  test("trims whitespace from command text", () => {
    const body = "!`  gh pr diff  `";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(1);
    expect(result.expansions[0].command).toBe("gh pr diff");
  });

  test("returns empty expansions for body with no tokens", () => {
    const body = "Just a normal skill body with no inline commands.";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("returns empty expansions for empty body", () => {
    const result = parseInlineCommandExpansions("");

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // ─── Byte offsets ───────────────────────────────────────────────────────────

  test("startOffset and endOffset match the token positions", () => {
    const body = "abc !`cmd` def";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(1);
    const exp = result.expansions[0];
    // "abc " = 4 chars, then !`cmd` = 6 chars
    expect(exp.startOffset).toBe(4);
    expect(exp.endOffset).toBe(10);
    expect(body.slice(exp.startOffset, exp.endOffset)).toBe("!`cmd`");
  });

  // ─── Fenced code block handling ─────────────────────────────────────────────

  test("ignores tokens inside fenced code blocks with backtick fence", () => {
    const body = [
      "Normal text with !`real command`",
      "",
      "```",
      "Example: !`gh pr diff`",
      "```",
      "",
      "More text with !`another real command`",
    ].join("\n");

    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(2);
    expect(result.expansions[0].command).toBe("real command");
    expect(result.expansions[1].command).toBe("another real command");
  });

  test("ignores tokens inside fenced code blocks with tilde fence", () => {
    const body = [
      "~~~",
      "!`should be ignored`",
      "~~~",
      "",
      "!`should be found`",
    ].join("\n");

    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(1);
    expect(result.expansions[0].command).toBe("should be found");
  });

  test("ignores tokens inside fenced code blocks with info string", () => {
    const body = [
      "```markdown",
      "Use !`gh pr diff` to view changes",
      "```",
      "",
      "!`real command`",
    ].join("\n");

    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(1);
    expect(result.expansions[0].command).toBe("real command");
  });

  test("handles nested-like fence delimiters (longer opening fence)", () => {
    const body = [
      "````",
      "```",
      "!`inside nested`",
      "```",
      "````",
      "",
      "!`outside`",
    ].join("\n");

    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(1);
    expect(result.expansions[0].command).toBe("outside");
  });

  test("treats unclosed fenced code block as extending to EOF", () => {
    const body = [
      "```",
      "!`inside unclosed fence`",
      "This code block is never closed",
    ].join("\n");

    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  // ─── Fail-closed on malformed tokens ────────────────────────────────────────

  test("rejects empty command text", () => {
    const body = "!``";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("Empty command text");
    expect(result.errors[0].raw).toBe("!``");
    expect(result.errors[0].offset).toBe(0);
  });

  test("rejects whitespace-only command text", () => {
    const body = "!`   `";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("Empty command text");
  });

  test("reports unmatched opening backtick", () => {
    const body = "Some text !`unmatched";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toContain("Unmatched opening backtick");
    expect(result.errors[0].offset).toBe(10);
  });

  test("valid and malformed tokens can coexist", () => {
    const body = "!`good command` and !`` and !`another good`";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(2);
    expect(result.expansions[0].command).toBe("good command");
    expect(result.expansions[0].placeholderId).toBe(0);
    expect(result.expansions[1].command).toBe("another good");
    expect(result.expansions[1].placeholderId).toBe(1);

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].reason).toBe("Empty command text");
  });

  // ─── Placeholder ID stability ───────────────────────────────────────────────

  test("placeholder IDs are sequential by encounter order", () => {
    const body = "!`first` then !`second` and !`third`";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(3);
    expect(result.expansions[0].placeholderId).toBe(0);
    expect(result.expansions[1].placeholderId).toBe(1);
    expect(result.expansions[2].placeholderId).toBe(2);
  });

  test("malformed tokens do not consume placeholder IDs", () => {
    const body = "!`first` then !`` then !`second`";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(2);
    expect(result.expansions[0].placeholderId).toBe(0);
    expect(result.expansions[1].placeholderId).toBe(1);
  });

  // ─── List items and paragraphs ──────────────────────────────────────────────

  test("detects tokens in list items", () => {
    const body = [
      "- Step 1: !`git fetch`",
      "- Step 2: !`git rebase origin/main`",
    ].join("\n");

    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(2);
    expect(result.expansions[0].command).toBe("git fetch");
    expect(result.expansions[1].command).toBe("git rebase origin/main");
  });

  test("detects tokens across multiple paragraphs", () => {
    const body = [
      "First paragraph with !`cmd1`.",
      "",
      "Second paragraph with !`cmd2`.",
    ].join("\n");

    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(2);
    expect(result.expansions[0].command).toBe("cmd1");
    expect(result.expansions[1].command).toBe("cmd2");
  });

  // ─── Edge cases ─────────────────────────────────────────────────────────────

  test("does not match regular backtick code spans", () => {
    const body = "Use `gh pr diff` to view changes";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("does not match bare exclamation marks", () => {
    const body = "This is exciting! And `code` too!";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  test("handles token at start of body", () => {
    const body = "!`first thing`";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(1);
    expect(result.expansions[0].command).toBe("first thing");
    expect(result.expansions[0].startOffset).toBe(0);
  });

  test("handles token at end of body", () => {
    const body = "Do this: !`last thing`";
    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(1);
    expect(result.expansions[0].command).toBe("last thing");
    expect(result.expansions[0].endOffset).toBe(body.length);
  });

  test("unmatched backtick inside fenced code block is not an error", () => {
    const body = ["```", "!`unmatched inside fence", "```"].join("\n");

    const result = parseInlineCommandExpansions(body);

    expect(result.expansions).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });
});
