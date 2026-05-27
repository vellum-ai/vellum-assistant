import { describe, expect, it } from "bun:test";

import {
  applyMarkdownFormatting,
  matchFormattingShortcut,
} from "@/domains/chat/components/chat-composer/markdown-formatting";

describe("applyMarkdownFormatting", () => {
  describe("bold (**)", () => {
    it("wraps selected text with bold markers", () => {
      // GIVEN text with a selection
      const text = "hello world";
      const selectionStart = 6;
      const selectionEnd = 11;

      // WHEN applying bold formatting
      const result = applyMarkdownFormatting(text, selectionStart, selectionEnd, "**");

      // THEN the selection is wrapped with ** markers
      expect(result.text).toBe("hello **world**");
      // AND the selection covers the wrapped text (excluding markers)
      expect(result.selectionStart).toBe(8);
      expect(result.selectionEnd).toBe(13);
    });

    it("inserts empty bold markers at cursor when no selection", () => {
      // GIVEN text with a collapsed cursor (no selection)
      const text = "hello world";
      const cursor = 5;

      // WHEN applying bold formatting
      const result = applyMarkdownFormatting(text, cursor, cursor, "**");

      // THEN paired markers are inserted with cursor between them
      expect(result.text).toBe("hello**** world");
      expect(result.selectionStart).toBe(7);
      expect(result.selectionEnd).toBe(7);
    });

    it("toggles off bold when selection is already wrapped", () => {
      // GIVEN text where the selection is already bold-wrapped
      const text = "hello **world**";
      const selectionStart = 8;
      const selectionEnd = 13;

      // WHEN applying bold formatting again
      const result = applyMarkdownFormatting(text, selectionStart, selectionEnd, "**");

      // THEN the markers are removed
      expect(result.text).toBe("hello world");
      expect(result.selectionStart).toBe(6);
      expect(result.selectionEnd).toBe(11);
    });
  });

  describe("italic (*)", () => {
    it("wraps selected text with italic marker", () => {
      // GIVEN text with a selection
      const text = "hello world";

      // WHEN applying italic formatting to "world"
      const result = applyMarkdownFormatting(text, 6, 11, "*");

      // THEN the selection is wrapped with * markers
      expect(result.text).toBe("hello *world*");
      expect(result.selectionStart).toBe(7);
      expect(result.selectionEnd).toBe(12);
    });

    it("toggles off italic when already wrapped", () => {
      // GIVEN text where the selection is already italic-wrapped
      const text = "hello *world*";

      // WHEN applying italic formatting to the wrapped text
      const result = applyMarkdownFormatting(text, 7, 12, "*");

      // THEN the markers are removed
      expect(result.text).toBe("hello world");
      expect(result.selectionStart).toBe(6);
      expect(result.selectionEnd).toBe(11);
    });
  });

  describe("strikethrough (~~)", () => {
    it("wraps selected text with strikethrough markers", () => {
      // GIVEN text with a selection
      const text = "remove this";

      // WHEN applying strikethrough formatting
      const result = applyMarkdownFormatting(text, 0, 6, "~~");

      // THEN the selection is wrapped with ~~ markers
      expect(result.text).toBe("~~remove~~ this");
      expect(result.selectionStart).toBe(2);
      expect(result.selectionEnd).toBe(8);
    });
  });

  describe("inline code (`)", () => {
    it("wraps selected text with backtick markers", () => {
      // GIVEN text with a selection
      const text = "use the function here";

      // WHEN applying inline code formatting to "function"
      const result = applyMarkdownFormatting(text, 8, 16, "`");

      // THEN the selection is wrapped with backticks
      expect(result.text).toBe("use the `function` here");
      expect(result.selectionStart).toBe(9);
      expect(result.selectionEnd).toBe(17);
    });
  });

  describe("edge cases", () => {
    it("handles formatting at the start of text", () => {
      // GIVEN selection at the beginning of text
      const text = "hello";

      // WHEN applying bold formatting
      const result = applyMarkdownFormatting(text, 0, 5, "**");

      // THEN the entire text is wrapped
      expect(result.text).toBe("**hello**");
      expect(result.selectionStart).toBe(2);
      expect(result.selectionEnd).toBe(7);
    });

    it("handles empty text with collapsed cursor", () => {
      // GIVEN empty text
      const text = "";

      // WHEN applying bold formatting
      const result = applyMarkdownFormatting(text, 0, 0, "**");

      // THEN paired markers are inserted
      expect(result.text).toBe("****");
      expect(result.selectionStart).toBe(2);
      expect(result.selectionEnd).toBe(2);
    });
  });
});

describe("matchFormattingShortcut", () => {
  it("matches Ctrl+B as bold", () => {
    // WHEN pressing Ctrl+B
    const result = matchFormattingShortcut({
      key: "b",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    });

    // THEN bold marker is returned
    expect(result).toBe("**");
  });

  it("matches Cmd+B as bold", () => {
    // WHEN pressing Cmd+B
    const result = matchFormattingShortcut({
      key: "b",
      ctrlKey: false,
      metaKey: true,
      shiftKey: false,
    });

    // THEN bold marker is returned
    expect(result).toBe("**");
  });

  it("matches Ctrl+I as italic", () => {
    // WHEN pressing Ctrl+I
    const result = matchFormattingShortcut({
      key: "i",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    });

    // THEN italic marker is returned
    expect(result).toBe("*");
  });

  it("matches Ctrl+Shift+X as strikethrough", () => {
    // WHEN pressing Ctrl+Shift+X
    const result = matchFormattingShortcut({
      key: "x",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    });

    // THEN strikethrough marker is returned
    expect(result).toBe("~~");
  });

  it("matches Ctrl+Shift+C as inline code", () => {
    // WHEN pressing Ctrl+Shift+C
    const result = matchFormattingShortcut({
      key: "c",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    });

    // THEN inline code marker is returned
    expect(result).toBe("`");
  });

  it("returns null for Ctrl+B with Shift (not a formatting shortcut)", () => {
    // WHEN pressing Ctrl+Shift+B
    const result = matchFormattingShortcut({
      key: "b",
      ctrlKey: true,
      metaKey: false,
      shiftKey: true,
    });

    // THEN no match
    expect(result).toBeNull();
  });

  it("returns null when no modifier key is pressed", () => {
    // WHEN pressing B without modifier
    const result = matchFormattingShortcut({
      key: "b",
      ctrlKey: false,
      metaKey: false,
      shiftKey: false,
    });

    // THEN no match
    expect(result).toBeNull();
  });

  it("returns null for unrecognized key combinations", () => {
    // WHEN pressing Ctrl+Z (not a formatting shortcut)
    const result = matchFormattingShortcut({
      key: "z",
      ctrlKey: true,
      metaKey: false,
      shiftKey: false,
    });

    // THEN no match
    expect(result).toBeNull();
  });
});
