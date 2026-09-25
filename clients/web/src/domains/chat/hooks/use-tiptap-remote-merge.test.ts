import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";
import { cleanup, renderHook } from "@testing-library/react";
import { toast } from "@vellumai/design-library";

import {
  buildDocumentEditorExtensions,
  getEditorMarkdown,
} from "@/domains/chat/components/tiptap-editor-extensions";

import { useTiptapRemoteMerge } from "./use-tiptap-remote-merge";

const BASE = "First paragraph.\n\nSecond paragraph.";

let editor: Editor | null = null;

function renderMerge() {
  const ed = new Editor({
    extensions: buildDocumentEditorExtensions(),
    content: BASE,
  });
  editor = ed;
  const onMerged = mock((_markdown: string) => {});
  const hook = renderHook(
    ({ content, sentContent }) =>
      useTiptapRemoteMerge({ editor: ed, content, sentContent, onMerged }),
    {
      initialProps: { content: BASE, sentContent: BASE as string | undefined },
    },
  );
  return { ...hook, ed, onMerged };
}

function typeAfter(ed: Editor, anchorText: string, text: string) {
  let pos = -1;
  ed.state.doc.descendants((node, offset) => {
    if (pos === -1 && node.isText && node.text?.includes(anchorText)) {
      pos = offset + node.text.indexOf(anchorText) + anchorText.length;
    }
  });
  ed.view.dispatch(
    ed.state.tr
      .setSelection(TextSelection.create(ed.state.doc, pos))
      .insertText(text),
  );
}

afterEach(() => {
  cleanup();
  editor?.destroy();
  editor = null;
});

describe("useTiptapRemoteMerge", () => {
  test("applies an incoming body without reporting a merge to save", () => {
    const { ed, rerender, onMerged } = renderMerge();
    rerender({ content: `${BASE}\n\nThird paragraph.`, sentContent: BASE });
    expect(getEditorMarkdown(ed)).toContain("Third paragraph.");
    expect(onMerged).not.toHaveBeenCalled();
  });

  test("reports the merged body when local edits were kept", () => {
    const { ed, rerender, onMerged } = renderMerge();
    typeAfter(ed, "First paragraph", " typed");
    rerender({
      content: BASE.replace("Second", "Remote second"),
      sentContent: BASE,
    });
    expect(onMerged).toHaveBeenCalledTimes(1);
    const merged = onMerged.mock.calls[0]![0];
    expect(merged).toContain("First paragraph typed.");
    expect(merged).toContain("Remote second paragraph.");
    expect(getEditorMarkdown(ed)).toBe(merged);
  });

  test("warns once when a conflicting hunk keeps the user's text", () => {
    const warning = spyOn(toast, "warning").mockReturnValue("conflict");
    const { ed, rerender } = renderMerge();
    typeAfter(ed, "Second", " local");
    rerender({
      content: BASE.replace("Second paragraph.", "Rewritten."),
      sentContent: BASE,
    });
    expect(getEditorMarkdown(ed)).toContain("Second local paragraph.");
    expect(warning).toHaveBeenCalledTimes(1);
    warning.mockRestore();
  });

  test("a sent body becomes a merge base, so its echo changes nothing", () => {
    const { ed, rerender, onMerged } = renderMerge();
    typeAfter(ed, "Second paragraph.", " Saved.");
    const saved = getEditorMarkdown(ed);
    rerender({ content: BASE, sentContent: saved });
    const before = ed.state.doc;
    rerender({ content: saved, sentContent: saved });
    expect(ed.state.doc).toBe(before);
    expect(onMerged).not.toHaveBeenCalled();
  });
});
