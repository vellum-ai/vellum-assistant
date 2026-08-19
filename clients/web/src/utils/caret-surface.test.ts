/**
 * Tests for the shared caret-drag predicate.
 *
 * Both gesture guards that consume it (`ownsHorizontalTextDrag` in
 * `use-edge-swipe`, `ownsVerticalTextDrag` in `use-swipe-down-dismiss-keyboard`)
 * have their own suites for the transcript-selection policy they layer on top.
 * This file pins only the part they share.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { ownsCaretDrag } from "@/utils/caret-surface";

afterEach(() => {
  document.body.replaceChildren();
});

describe("ownsCaretDrag", () => {
  test("is true for the form controls a drag places a caret in", () => {
    expect(ownsCaretDrag(document.createElement("input"))).toBe(true);
    expect(ownsCaretDrag(document.createElement("textarea"))).toBe(true);
    expect(ownsCaretDrag(document.createElement("select"))).toBe(true);
  });

  test("is true inside a contenteditable region", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.appendChild(child);
    document.body.appendChild(editor);

    expect(ownsCaretDrag(editor)).toBe(true);
    expect(ownsCaretDrag(child)).toBe(true);
  });

  test("is false for an explicitly non-editable region", () => {
    const region = document.createElement("div");
    region.setAttribute("contenteditable", "false");
    document.body.appendChild(region);

    expect(ownsCaretDrag(region)).toBe(false);
  });

  test("leaves selectable transcript text to each caller's own policy", () => {
    // The two gestures disagree about `[data-message-text]` on purpose, so it
    // deliberately does not belong to the shared predicate.
    const message = document.createElement("div");
    message.setAttribute("data-message-text", "");
    document.body.appendChild(message);

    expect(ownsCaretDrag(message)).toBe(false);
  });

  test("is false for chrome and for a non-element target", () => {
    const header = document.createElement("header");
    document.body.appendChild(header);

    expect(ownsCaretDrag(header)).toBe(false);
    expect(ownsCaretDrag(null)).toBe(false);
    expect(ownsCaretDrag(document)).toBe(false);
  });
});
