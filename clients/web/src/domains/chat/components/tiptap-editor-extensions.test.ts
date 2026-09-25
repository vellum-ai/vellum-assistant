/**
 * Tests for the document editor extension list, using a headless tiptap
 * Editor (no React mount). The critical behavior is GFM table support:
 * tiptap-markdown parses pipe tables into <table> HTML, and the schema must
 * have table nodes to hold them. Without them ProseMirror flattens cell text
 * into paragraphs, and the next save writes the corrupted doc back to disk.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";

import {
  buildDocumentEditorExtensions,
  getEditorMarkdown,
  normalizeLinkHref,
} from "./tiptap-editor-extensions";

const TABLE_MARKDOWN = [
  "# Demo",
  "",
  "| config | output |",
  "|---|---|",
  "| unsteered | a plain poem |",
  "| steered 0.9 | an elegy |",
].join("\n");

let editor: Editor | null = null;

function createEditor(content: string): Editor {
  editor = new Editor({
    extensions: buildDocumentEditorExtensions(),
    content,
  });
  return editor;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("buildDocumentEditorExtensions", () => {
  test("parses GFM tables into table nodes instead of flattening cells", () => {
    const ed = createEditor(TABLE_MARKDOWN);
    const html = ed.getHTML();

    expect(html).toContain("<table");
    expect(html.match(/<th/g)?.length).toBe(2);
    expect(html.match(/<td/g)?.length).toBe(4);
    // Cell text must stay in separate cells, not run together in a paragraph.
    expect(html).not.toContain("configoutput");
    expect(html).not.toContain("unsteereda plain poem");
  });

  test("round-trips a table back to pipe markdown on serialize", () => {
    const ed = createEditor(TABLE_MARKDOWN);
    const md = getEditorMarkdown(ed);

    expect(md).toContain("| config | output |");
    expect(md).toContain("| --- | --- |");
    expect(md).toContain("| unsteered | a plain poem |");
    expect(md).toContain("| steered 0.9 | an elegy |");
  });

  test("editing outside a table preserves the table on serialize", () => {
    const ed = createEditor(TABLE_MARKDOWN);
    ed.commands.insertContentAt(ed.state.doc.content.size, {
      type: "paragraph",
      content: [{ type: "text", text: "closing note" }],
    });

    const md = getEditorMarkdown(ed);
    expect(md).toContain("closing note");
    expect(md).toContain("| config | output |");
    expect(md).toContain("| --- | --- |");
  });
});

describe("block formatting round-trips through markdown", () => {
  const BLOCKS_MARKDOWN = [
    "# Title",
    "",
    "## Section",
    "",
    "### Detail",
    "",
    "- one",
    "- two",
    "",
    "1. first",
    "2. second",
    "",
    "> quoted line",
    "",
    "See [the docs](https://example.com/docs) or [mail](mailto:user@example.com).",
  ].join("\n");

  test("headings, lists, quotes and links serialize back unchanged", () => {
    const ed = createEditor(BLOCKS_MARKDOWN);
    expect(getEditorMarkdown(ed)).toBe(BLOCKS_MARKDOWN);
  });

  test("the toolbar's block commands produce markdown blocks", () => {
    const ed = createEditor("alpha\n\nbeta\n\ngamma\n\ndelta");
    const selectParagraph = (text: string) => {
      let pos = -1;
      ed.state.doc.descendants((node, offset) => {
        if (pos === -1 && node.isTextblock && node.textContent === text) {
          pos = offset + 1;
        }
      });
      ed.commands.setTextSelection({ from: pos, to: pos + text.length });
    };

    selectParagraph("alpha");
    ed.commands.setHeading({ level: 2 });
    selectParagraph("beta");
    ed.commands.toggleBulletList();
    selectParagraph("gamma");
    ed.commands.toggleOrderedList();
    selectParagraph("delta");
    ed.commands.toggleBlockquote();

    expect(getEditorMarkdown(ed)).toBe(
      ["## alpha", "", "- beta", "", "1. gamma", "", "> delta"].join("\n"),
    );
  });

  test("a link set from the toolbar serializes as a markdown link", () => {
    const ed = createEditor("read this");
    ed.commands.setTextSelection({ from: 1, to: 5 });
    const href = normalizeLinkHref("example.com/guide");
    expect(href).toBe("https://example.com/guide");
    ed.commands.setLink({ href: href! });
    expect(getEditorMarkdown(ed)).toBe("[read](https://example.com/guide) this");
  });

  test("an empty document serializes to an empty string, not the placeholder", () => {
    editor = new Editor({
      extensions: buildDocumentEditorExtensions({ placeholder: "Start writing" }),
      content: "",
    });
    expect(getEditorMarkdown(editor)).toBe("");
  });
});

describe("normalizeLinkHref", () => {
  test.each([
    ["https://example.com/a?b=1", "https://example.com/a?b=1"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["example.com", "https://example.com"],
    ["  www.example.org/page  ", "https://www.example.org/page"],
    ["example.com:8080/path", "https://example.com:8080/path"],
    ["//example.com/p", "https://example.com/p"],
    ["mailto:user@example.com", "mailto:user@example.com"],
    ["user@example.com", "mailto:user@example.com"],
  ])("accepts %p as %p", (input, expected) => {
    expect(normalizeLinkHref(input)).toBe(expected);
  });

  test.each([
    "",
    "   ",
    "hello",
    "not a link",
    "javascript:alert(1)",
    "data:text/html,hi",
    "ftp://example.com",
    "file:///etc/hosts",
    "https://",
    "mailto:",
    "user@",
  ])("rejects %p", (input) => {
    expect(normalizeLinkHref(input)).toBeNull();
  });
});
