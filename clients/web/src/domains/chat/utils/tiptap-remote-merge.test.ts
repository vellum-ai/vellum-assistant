/**
 * Tests for merging streamed document bodies into a live headless editor,
 * built from the production extension list.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Editor } from "@tiptap/core";
import { TextSelection } from "@tiptap/pm/state";

import {
  buildDocumentEditorExtensions,
  getEditorMarkdown,
} from "@/domains/chat/components/tiptap-editor-extensions";

import {
  diffDocs,
  parseEditorMarkdown,
  RemoteMergeTracker,
  serializeEditorDoc,
} from "./tiptap-remote-merge";

const BASE = [
  "# Plan",
  "",
  "Alpha paragraph one.",
  "",
  "Beta paragraph two.",
  "",
  "Gamma paragraph three.",
].join("\n");

let editor: Editor | null = null;

interface Harness {
  editor: Editor;
  tracker: RemoteMergeTracker;
  receive: (markdown: string) => { applied: boolean; conflicted: boolean };
  save: () => string;
  typeAt: (text: string, anchorText: string, offset?: number) => void;
  markdown: () => string;
}

function setup(content: string): Harness {
  const ed = new Editor({
    extensions: buildDocumentEditorExtensions(),
    content,
  });
  editor = ed;
  const tracker = new RemoteMergeTracker(ed.state.doc);
  ed.on("transaction", ({ transaction, appendedTransactions }) => {
    tracker.applyTransaction(transaction);
    for (const appended of appendedTransactions) {
      tracker.applyTransaction(appended);
    }
  });
  return {
    editor: ed,
    tracker,
    receive(markdown) {
      const result = tracker.merge(ed.state, parseEditorMarkdown(ed, markdown));
      if (!result) {
        return { applied: false, conflicted: false };
      }
      ed.view.dispatch(result.tr);
      return { applied: true, conflicted: result.conflicted };
    },
    save() {
      const markdown = getEditorMarkdown(ed);
      tracker.markSent(markdown, (doc) => serializeEditorDoc(ed, doc));
      return markdown;
    },
    typeAt(text, anchorText, offset = anchorText.length) {
      const pos = findText(ed, anchorText) + offset;
      ed.view.dispatch(
        ed.state.tr
          .setSelection(TextSelection.create(ed.state.doc, pos))
          .insertText(text),
      );
    },
    markdown: () => getEditorMarkdown(ed),
  };
}

function findText(ed: Editor, text: string): number {
  let found = -1;
  ed.state.doc.descendants((node, pos) => {
    if (found === -1 && node.isText && node.text?.includes(text)) {
      found = pos + node.text.indexOf(text);
    }
  });
  if (found === -1) {
    throw new Error(`"${text}" is not in the document`);
  }
  return found;
}

afterEach(() => {
  editor?.destroy();
  editor = null;
});

describe("diffDocs", () => {
  test("keeps separate block edits as separate hunks", () => {
    const h = setup(BASE);
    const next = BASE.replace("Alpha", "ALPHA").replace("Gamma", "GAMMA");
    const hunks = diffDocs(
      h.editor.state.doc,
      parseEditorMarkdown(h.editor, next),
    );
    expect(hunks).toHaveLength(2);
  });

  test("returns nothing for the same body", () => {
    const h = setup(BASE);
    expect(
      diffDocs(h.editor.state.doc, parseEditorMarkdown(h.editor, BASE)),
    ).toEqual([]);
  });
});

describe("RemoteMergeTracker", () => {
  test("merging an identical body is a no-op", () => {
    const h = setup(BASE);
    const before = h.editor.state.doc;
    expect(h.receive(BASE)).toEqual({ applied: false, conflicted: false });
    expect(h.editor.state.doc).toBe(before);
    expect(h.receive(h.markdown())).toEqual({
      applied: false,
      conflicted: false,
    });
  });

  test("a remote change with no local edits preserves the selection", () => {
    const h = setup(BASE);
    const caret = findText(h.editor, "Gamma") + 2;
    h.editor.view.dispatch(
      h.editor.state.tr.setSelection(
        TextSelection.create(h.editor.state.doc, caret),
      ),
    );
    const caretText = h.editor.state.doc.textBetween(caret - 2, caret + 3);

    const result = h.receive(
      BASE.replace("Alpha paragraph one.", "Alpha paragraph one, now longer."),
    );

    expect(result).toEqual({ applied: true, conflicted: false });
    expect(h.markdown()).toContain("Alpha paragraph one, now longer.");
    const { from, to } = h.editor.state.selection;
    expect(from).toBe(to);
    expect(h.editor.state.doc.textBetween(from - 2, from + 3)).toBe(caretText);
  });

  test("a remote merge stays out of the user's undo history", () => {
    const h = setup(BASE);
    h.typeAt(" local", "Beta paragraph two");
    h.receive(BASE.replace("Gamma", "Remote gamma"));
    h.editor.commands.undo();
    expect(h.markdown()).toContain("Remote gamma");
    expect(h.markdown()).not.toContain(" local");
  });

  test("local typing in one paragraph and a remote edit in another both survive", () => {
    const h = setup(BASE);
    h.typeAt(" (typed)", "Alpha paragraph one");

    const result = h.receive(
      BASE.replace("Gamma paragraph three.", "Gamma paragraph rewritten."),
    );

    expect(result).toEqual({ applied: true, conflicted: false });
    const md = h.markdown();
    expect(md).toContain("Alpha paragraph one (typed).");
    expect(md).toContain("Gamma paragraph rewritten.");
    expect(md).not.toContain("Gamma paragraph three.");
  });

  test("an append while the user types lands after the user's text", () => {
    const h = setup(BASE);
    h.typeAt(" More local words.", "Gamma paragraph three.");

    const result = h.receive(`${BASE}\n\nAppended by the assistant.`);

    expect(result).toEqual({ applied: true, conflicted: false });
    const md = h.markdown();
    expect(md).toContain("Gamma paragraph three. More local words.");
    expect(md.trimEnd().endsWith("Appended by the assistant.")).toBe(true);
  });

  test("an append onto the last received body keeps text saved since", () => {
    const h = setup(BASE);
    h.typeAt(" Saved locally.", "Beta paragraph two.");
    h.save();

    // The viewer store appends onto the body it last received, which never
    // saw the local save.
    const result = h.receive(`${BASE}\n\nAppended chunk.`);

    expect(result).toEqual({ applied: true, conflicted: false });
    const md = h.markdown();
    expect(md).toContain("Beta paragraph two. Saved locally.");
    expect(md.trimEnd().endsWith("Appended chunk.")).toBe(true);
  });

  test("an unchanged body with a table is a no-op", () => {
    const table = [
      BASE,
      "",
      "| config | output |",
      "| --- | --- |",
      "| a | b |",
    ].join("\n");
    const h = setup(table);
    expect(h.receive(table).applied).toBe(false);
    expect(h.receive(h.markdown()).applied).toBe(false);
  });

  test("consecutive appends keep extending the end", () => {
    const h = setup(BASE);
    h.typeAt("!", "Alpha paragraph one.");
    const first = `${BASE}\n\nFirst chunk.`;
    h.receive(first);
    h.receive(`${first}\n\nSecond chunk.`);
    const md = h.markdown();
    expect(md).toContain("Alpha paragraph one.!");
    expect(md.indexOf("First chunk.")).toBeLessThan(
      md.indexOf("Second chunk."),
    );
    expect(md.match(/First chunk\./g)).toHaveLength(1);
  });

  test("a remote edit inside text the user changed keeps the user's text", () => {
    const h = setup(BASE);
    h.typeAt(" edited locally", "Beta paragraph");

    const result = h.receive(
      BASE.replace("Beta paragraph two.", "Beta rewritten remotely.").replace(
        "Gamma paragraph three.",
        "Gamma rewritten remotely.",
      ),
    );

    expect(result).toEqual({ applied: true, conflicted: true });
    const md = h.markdown();
    expect(md).toContain("Beta paragraph edited locally two.");
    expect(md).not.toContain("Beta rewritten remotely.");
    // The hunk that did not overlap still applies.
    expect(md).toContain("Gamma rewritten remotely.");
  });

  test("a replacement built on a saved body does not duplicate saved text", () => {
    const h = setup(BASE);
    h.typeAt(" Saved addition.", "Gamma paragraph three.");
    const saved = h.save();

    // The assistant read the saved body and edited another paragraph.
    const result = h.receive(saved.replace("Alpha", "Remote alpha"));

    expect(result.conflicted).toBe(false);
    const md = h.markdown();
    expect(md).toContain("Remote alpha paragraph one.");
    expect(md.match(/Saved addition\./g)).toHaveLength(1);
  });

  test("a replacement on an older save keeps typing saved after it", () => {
    const h = setup(BASE);
    h.typeAt(" first", "Alpha paragraph one");
    const olderSave = h.save();
    h.typeAt(" second", "Beta paragraph two");
    h.save();

    const result = h.receive(olderSave.replace("Gamma", "Remote gamma"));

    expect(result.conflicted).toBe(false);
    const md = h.markdown();
    expect(md).toContain("Alpha paragraph one first.");
    expect(md).toContain("Beta paragraph two second.");
    expect(md).toContain("Remote gamma paragraph three.");
  });

  test("the saved merge round-trips: receiving it again changes nothing", () => {
    const h = setup(BASE);
    h.typeAt(" local", "Alpha paragraph one");
    h.receive(BASE.replace("Gamma", "Remote gamma"));
    // The editor reports the merge through the save path, which writes it.
    const merged = h.save();
    const before = h.editor.state.doc;
    expect(h.receive(merged).applied).toBe(false);
    expect(h.editor.state.doc).toBe(before);
    expect(parseEditorMarkdown(h.editor, merged).eq(before)).toBe(true);
  });

  test("a later remote edit to remotely inserted text maps into it", () => {
    const h = setup(BASE);
    const first = `${BASE}\n\nInserted remotely.`;
    h.receive(first);
    h.typeAt(" typed", "Alpha paragraph one");
    const result = h.receive(
      first.replace("Inserted remotely.", "Inserted and revised remotely."),
    );
    expect(result).toEqual({ applied: true, conflicted: false });
    const md = h.markdown();
    expect(md).toContain("Inserted and revised remotely.");
    expect(md).toContain("Alpha paragraph one typed.");
  });
});
