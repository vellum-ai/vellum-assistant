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
