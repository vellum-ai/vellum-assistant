import { describe, expect, test } from "bun:test";

import {
  splitMarkdownBlocks,
  type MarkdownBlockSplit,
} from "./markdown-blocks";

function blocksOf(content: string): readonly string[] {
  return splitMarkdownBlocks(content).blocks;
}

/**
 * Feeds `content` in one-character appends, threading each result into the
 * next call, and returns the final split. Mirrors how a streamed document
 * reaches the renderer.
 */
function streamed(content: string): MarkdownBlockSplit {
  let split: MarkdownBlockSplit | undefined;
  for (let i = 1; i <= content.length; i++) {
    split = splitMarkdownBlocks(content.slice(0, i), split);
  }
  return split ?? splitMarkdownBlocks("");
}

describe("splitMarkdownBlocks", () => {
  test("empty content has no blocks", () => {
    expect(blocksOf("")).toEqual([]);
  });

  test("a single paragraph is one block", () => {
    expect(blocksOf("just one line")).toEqual(["just one line"]);
  });

  test("cuts at a blank line before a column-0 line, keeping the blank with the block before", () => {
    expect(blocksOf("first\n\nsecond\n\n\nthird")).toEqual([
      "first\n\n",
      "second\n\n\n",
      "third",
    ]);
  });

  test("blocks always concatenate back to the source", () => {
    const content =
      "# Title\n\npara one\nstill one\n\n- a\n- b\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\n> quote\n\nend\n";
    expect(blocksOf(content).join("")).toBe(content);
  });

  test("a blank line inside a fenced code block does not cut", () => {
    expect(blocksOf("```\na\n\nb\n```\n\nafter")).toEqual([
      "```\na\n\nb\n```\n\n",
      "after",
    ]);
  });

  test("a tilde fence is not closed by backticks, nor by a shorter fence", () => {
    expect(blocksOf("~~~~\n```\n\n~~~\n\nx\n~~~~\n\nafter")).toEqual([
      "~~~~\n```\n\n~~~\n\nx\n~~~~\n\n",
      "after",
    ]);
  });

  test("an unclosed fence swallows the rest of the document", () => {
    expect(blocksOf("intro\n\n```\ncode\n\nmore\n\nstill code")).toEqual([
      "intro\n\n",
      "```\ncode\n\nmore\n\nstill code",
    ]);
  });

  test("a blank line inside a $$ math block does not cut", () => {
    expect(blocksOf("$$\na = b\n\nc = d\n$$\n\nafter")).toEqual([
      "$$\na = b\n\nc = d\n$$\n\n",
      "after",
    ]);
  });

  test("single-line $$x$$ math does not open a fence", () => {
    expect(blocksOf("$$x$$\n\nafter")).toEqual(["$$x$$\n\n", "after"]);
  });

  test("a math fence opened with more dollars is not closed by fewer", () => {
    // remark-math accepts any run of two or more dollars as the opener and
    // requires the closer to be at least as long, like a code fence.
    expect(blocksOf("$$$\na\n\n$$\n\nb\n$$$\n\nafter")).toEqual([
      "$$$\na\n\n$$\n\nb\n$$$\n\n",
      "after",
    ]);
    expect(blocksOf("$$$$\na\n\nb\n$$$$\n\nafter")).toEqual([
      "$$$$\na\n\nb\n$$$$\n\n",
      "after",
    ]);
  });

  test("a math fence opener may carry meta, but not another dollar", () => {
    expect(blocksOf("$$ asciimath\na\n\nb\n$$\n\nafter")).toEqual([
      "$$ asciimath\na\n\nb\n$$\n\n",
      "after",
    ]);
    expect(blocksOf("$$ costs $5\n\nafter")).toEqual([
      "$$ costs $5\n\n",
      "after",
    ]);
  });

  test("an indented line after a blank stays with its block", () => {
    // A list item's continuation paragraph, and an indented code block.
    expect(blocksOf("- item\n\n  continued\n\nnext")).toEqual([
      "- item\n\n  continued\n\n",
      "next",
    ]);
    expect(blocksOf("    code\n\n    more code\n\nprose")).toEqual([
      "    code\n\n    more code\n\n",
      "prose",
    ]);
  });

  test("a loose list stays one block", () => {
    expect(blocksOf("- a\n\n- b\n\n1. c\n\n2. d\n\nafter")).toEqual([
      "- a\n\n- b\n\n1. c\n\n2. d\n\n",
      "after",
    ]);
  });

  test("a loose list that interrupts a paragraph stays one block", () => {
    // No blank line between the lead-in and the first item: the list is the
    // block's current construct even though its first line is prose.
    expect(blocksOf("Steps:\n- one\n\n- two\n\nafter")).toEqual([
      "Steps:\n- one\n\n- two\n\n",
      "after",
    ]);
  });

  test("a list whose first marker is indented up to three spaces is still a list", () => {
    expect(blocksOf(" - one\n\n- two\n\nafter")).toEqual([
      " - one\n\n- two\n\n",
      "after",
    ]);
    expect(blocksOf("   1. one\n\n2. two\n\nafter")).toEqual([
      "   1. one\n\n2. two\n\n",
      "after",
    ]);
  });

  test("a line of non-breaking spaces is content, not a blank line", () => {
    // CommonMark blank lines hold only spaces and tabs, so this stays one
    // paragraph and must not be cut.
    expect(blocksOf("a\n\u00a0\nb\n\nc")).toEqual(["a\n\u00a0\nb\n\n", "c"]);
    expect(blocksOf("a\n \t \nb")).toEqual(["a\n \t \n", "b"]);
  });

  test("a fence line followed by a non-breaking space does not close the fence", () => {
    expect(blocksOf("```\nx\n```\u00a0\n\ny\n```\n\nafter")).toEqual([
      "```\nx\n```\u00a0\n\ny\n```\n\n",
      "after",
    ]);
  });

  test("a lazy continuation keeps the list open", () => {
    expect(blocksOf("- one\nstill one\n\n- two\n\nafter")).toEqual([
      "- one\nstill one\n\n- two\n\n",
      "after",
    ]);
  });

  test("a list after a paragraph starts its own block", () => {
    expect(blocksOf("intro\n\n- a\n- b\n\nafter")).toEqual([
      "intro\n\n",
      "- a\n- b\n\n",
      "after",
    ]);
  });

  test("leading blank lines belong to the first block", () => {
    expect(blocksOf("\n\nfirst\n\nsecond")).toEqual([
      "\n\nfirst\n\n",
      "second",
    ]);
  });

  test("CRLF line endings are handled", () => {
    expect(blocksOf("a\r\n\r\nb\r\n```\r\nc\r\n\r\n```\r\n\r\nd")).toEqual([
      "a\r\n\r\n",
      "b\r\n```\r\nc\r\n\r\n```\r\n\r\n",
      "d",
    ]);
  });

  test("an empty list item under CRLF keeps the loose list whole", () => {
    expect(blocksOf("- one\r\n\r\n-\r\n\r\n- three\r\n\r\nafter")).toEqual([
      "- one\r\n\r\n-\r\n\r\n- three\r\n\r\n",
      "after",
    ]);
  });

  describe("incremental", () => {
    test("streamed appends produce the same blocks as one scan", () => {
      const content =
        "# Plan\n\nI should look at the file first.\nThen decide.\n\n- step one\n\n- step two\n  with detail\n\n```sh\nls -la\n\ncat file\n```\n\n$$\nx = 1\n$$\n\nDone thinking.\n";
      expect(streamed(content).blocks).toEqual(blocksOf(content));
    });

    test("settled blocks are carried over as the same strings", () => {
      const first = splitMarkdownBlocks("one\n\ntwo\n\nthr");
      const second = splitMarkdownBlocks("one\n\ntwo\n\nthree\n\nfour", first);
      expect(second.blocks).toEqual([
        "one\n\n",
        "two\n\n",
        "three\n\n",
        "four",
      ]);
      expect(second.blocks[0]).toBe(first.blocks[0]);
      expect(second.blocks[1]).toBe(first.blocks[1]);
    });

    test("an append that closes a fence lets later blocks settle", () => {
      const open = splitMarkdownBlocks("a\n\n```\ncode\n\nmore");
      expect(open.blocks).toEqual(["a\n\n", "```\ncode\n\nmore"]);
      const closed = splitMarkdownBlocks(
        "a\n\n```\ncode\n\nmore\n```\n\nafter",
        open,
      );
      expect(closed.blocks).toEqual([
        "a\n\n",
        "```\ncode\n\nmore\n```\n\n",
        "after",
      ]);
    });

    test("content that does not extend the previous result is rescanned", () => {
      const first = splitMarkdownBlocks("one\n\ntwo");
      const replaced = splitMarkdownBlocks("uno\n\ndos\n\ntres", first);
      expect(replaced.blocks).toEqual(["uno\n\n", "dos\n\n", "tres"]);
    });

    test("unchanged content yields the same blocks", () => {
      const first = splitMarkdownBlocks("one\n\ntwo");
      const again = splitMarkdownBlocks("one\n\ntwo", first);
      expect(again.blocks).toEqual(first.blocks);
    });

    test("an empty previous result is not treated as a prefix", () => {
      const empty = splitMarkdownBlocks("");
      expect(splitMarkdownBlocks("a\n\nb", empty).blocks).toEqual([
        "a\n\n",
        "b",
      ]);
    });
  });
});
