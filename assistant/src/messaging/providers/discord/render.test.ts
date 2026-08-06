import { describe, expect, test } from "bun:test";

import { DISCORD_MAX_MESSAGE_LENGTH, renderDiscordMessages } from "./render.js";

/** Count of fence lines in a chunk, which must be even for balanced markup. */
function fenceLineCount(chunk: string): number {
  return chunk.split("\n").filter((line) => /^\s*```/.test(line)).length;
}

/** The chunk text with fence bookkeeping lines removed. */
function withoutFences(chunk: string): string {
  return chunk
    .split("\n")
    .filter((line) => !/^\s*```/.test(line))
    .join("\n");
}

describe("renderDiscordMessages", () => {
  test("returns no chunks for blank input", () => {
    expect(renderDiscordMessages("")).toEqual([]);
    expect(renderDiscordMessages("   \n  ")).toEqual([]);
  });

  test("returns text under the cap unchanged, as a single chunk", () => {
    expect(renderDiscordMessages("hello **world**")).toEqual([
      "hello **world**",
    ]);
  });

  test("passes markdown through without rewriting it", () => {
    const markdown = "# Heading\n\n- one\n- two\n\n> quote\n\n`code` and *em*";
    expect(renderDiscordMessages(markdown)).toEqual([markdown]);
  });

  test("splits at the real Discord cap, not just the injectable one", () => {
    const text = "x".repeat(DISCORD_MAX_MESSAGE_LENGTH + 1);
    const chunks = renderDiscordMessages(text);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(DISCORD_MAX_MESSAGE_LENGTH);
    }
  });

  describe("with a small cap", () => {
    const MAX = 40;

    test("breaks on line boundaries and keeps every chunk within the cap", () => {
      const lines = Array.from({ length: 12 }, (_, i) => `line number ${i}`);
      const chunks = renderDiscordMessages(lines.join("\n"), MAX);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX);
      }
      // Nothing lost, nothing duplicated.
      expect(chunks.join("\n")).toBe(lines.join("\n"));
    });

    test("closes and reopens a code fence that spans a boundary", () => {
      const body = Array.from({ length: 8 }, (_, i) => `const x${i} = ${i};`);
      const text = ["```ts", ...body, "```"].join("\n");
      const chunks = renderDiscordMessages(text, MAX);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX);
        // Balanced markup: an odd count means a chunk renders as broken code.
        expect(fenceLineCount(chunk) % 2).toBe(0);
      }
      // Every continuation chunk reopens with the original info string, so the
      // language highlighting survives the split.
      for (const chunk of chunks.slice(1)) {
        expect(chunk.startsWith("```ts")).toBe(true);
      }
      // The code itself is intact once the injected fences are stripped.
      expect(chunks.map(withoutFences).join("\n")).toBe(body.join("\n"));
    });

    test("closes a four-backtick block with four backticks, not three", () => {
      // A closing fence must be at least as long as its opener, so a block
      // opened with ```` is not terminated by a ``` line: every chunk would
      // render as one unterminated code block.
      const body = Array.from({ length: 8 }, (_, i) => `line ${i}`);
      const chunks = renderDiscordMessages(
        ["````ts", ...body, "````"].join("\n"),
        MAX,
      );

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX);
        const fences = chunk.split("\n").filter((l) => /^\s*`{3,}/.test(l));
        expect(fences.length % 2).toBe(0);
        // Both ends of every chunk use the opener's own delimiter.
        for (const fence of fences) {
          expect(fence.trimStart().startsWith("````")).toBe(true);
        }
      }
    });

    test("a three-backtick line is content inside a four-backtick block", () => {
      // Opening with a longer run is exactly how a code block containing a
      // fence is written, so the inner ``` must not close the outer block.
      // The cap is small enough to force the splitter through its fence
      // bookkeeping rather than returning the text whole.
      const body = Array.from({ length: 6 }, (_, i) => `inner line ${i}`);
      const chunks = renderDiscordMessages(
        ["````md", "```ts", ...body, "```", "````"].join("\n"),
        MAX,
      );

      expect(chunks.length).toBeGreaterThan(1);
      // The outer block stays open throughout, so every continuation chunk
      // reopens with ````. Treating the inner ``` as a close would end the
      // block early and leave later chunks reopening with the wrong delimiter,
      // or not at all.
      for (const chunk of chunks.slice(1)) {
        expect(chunk.startsWith("````md")).toBe(true);
      }
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX);
        expect(chunk.trimEnd().endsWith("````")).toBe(true);
      }
      // The inner fences survive as content rather than being consumed.
      expect(chunks.join("\n")).toContain("```ts");
    });

    test("does not treat a fence inside an open block as a close", () => {
      // A fence line carrying an info string cannot close a block, so this
      // stays one code block rather than becoming two.
      const text = ["```md", "```ts", "still inside", "```"].join("\n");
      expect(renderDiscordMessages(text, 200)).toEqual([text]);
    });

    test("hard-splits a line longer than a whole chunk", () => {
      const chunks = renderDiscordMessages("y".repeat(MAX * 3), MAX);
      expect(chunks.length).toBeGreaterThan(2);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX);
      }
      expect(chunks.join("")).toBe("y".repeat(MAX * 3));
    });

    test("hard-splits an over-long line inside a code block within the cap", () => {
      // The reopened fence plus the closing fence eat into every continuation
      // chunk's budget; a split that ignores them overflows the cap.
      const text = ["```python", "z".repeat(MAX * 2), "```"].join("\n");
      const chunks = renderDiscordMessages(text, MAX);

      expect(chunks.length).toBeGreaterThan(1);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX);
        expect(fenceLineCount(chunk) % 2).toBe(0);
      }
      expect(chunks.map(withoutFences).join("")).toBe("z".repeat(MAX * 2));
    });

    test("charges the reopened fence against a code line that fits on its own", () => {
      // Geometry chosen so each body line fits a chunk when only the closing
      // fence is charged (30 + 4 <= 40) but not once the reopened "```python"
      // is charged too (10 + 30 + 4 > 40). Budgeting only the close overflows
      // the cap on every continuation chunk.
      const body = ["a".repeat(30), "b".repeat(30)];
      const chunks = renderDiscordMessages(
        ["```python", ...body, "```"].join("\n"),
        MAX,
      );

      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX);
        expect(fenceLineCount(chunk) % 2).toBe(0);
        // A chunk holding only a reopened fence pair renders as an empty code
        // block, which is what an unbudgeted reopen produces here.
        expect(withoutFences(chunk).trim().length).toBeGreaterThan(0);
      }
      // Each 30-char line exceeds what a continuation chunk can hold once the
      // fence pair is charged, so it is cut mid-line and the newline between
      // the two body lines does not survive. Character-level fidelity is the
      // guarantee that does: nothing dropped, nothing duplicated.
      expect(chunks.map(withoutFences).join("").replace(/\n/g, "")).toBe(
        body.join(""),
      );
    });

    test("never splits a surrogate pair", () => {
      const chunks = renderDiscordMessages("😀".repeat(MAX), MAX);
      for (const chunk of chunks) {
        expect(chunk.length).toBeLessThanOrEqual(MAX);
        // A broken pair leaves a lone surrogate at an edge.
        expect(chunk).not.toMatch(/[\uD800-\uDBFF]$/);
        expect(chunk).not.toMatch(/^[\uDC00-\uDFFF]/);
      }
      expect(chunks.join("")).toBe("😀".repeat(MAX));
    });

    test("emits no blank or fence-only chunks", () => {
      const text = ["```ts", "a".repeat(MAX - 10), "```"].join("\n");
      for (const chunk of renderDiscordMessages(text, MAX)) {
        expect(chunk.trim().length).toBeGreaterThan(0);
        expect(withoutFences(chunk).trim().length).toBeGreaterThan(0);
      }
    });
  });
});
