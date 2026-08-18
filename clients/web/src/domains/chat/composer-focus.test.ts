import { afterEach, describe, expect, test } from "bun:test";

import {
  consumePendingComposerFocus,
  insertTextAtSelection,
  isComposerFocusPending,
  requestComposerFocus,
  shouldFocusComposerForTyping,
  tryClaimComposerFocus,
} from "@/domains/chat/composer-focus";

const BASE_EVENT = {
  altKey: false,
  ctrlKey: false,
  defaultPrevented: false,
  isComposing: false,
  key: "a",
  keyCode: 65,
  metaKey: false,
} satisfies Parameters<typeof shouldFocusComposerForTyping>[0];

describe("shouldFocusComposerForTyping", () => {
  test("allows ordinary printable typing outside text entry controls", () => {
    const button = document.createElement("button");
    expect(shouldFocusComposerForTyping(BASE_EVENT, button)).toBe(true);
  });

  test("does not steal typing from text entry controls", () => {
    const input = document.createElement("input");
    expect(shouldFocusComposerForTyping(BASE_EVENT, input)).toBe(false);
  });

  test("does not steal shortcut or non-printable keys", () => {
    expect(
      shouldFocusComposerForTyping({ ...BASE_EVENT, metaKey: true }, null),
    ).toBe(false);
    expect(
      shouldFocusComposerForTyping({ ...BASE_EVENT, key: "Enter" }, null),
    ).toBe(false);
  });

  test("does not steal Space activation from focused buttons", () => {
    const button = document.createElement("button");
    expect(
      shouldFocusComposerForTyping({ ...BASE_EVENT, key: " " }, button),
    ).toBe(false);
  });
});

describe("insertTextAtSelection", () => {
  test("inserts text at the cursor", () => {
    expect(
      insertTextAtSelection({
        value: "helo",
        text: "l",
        selectionStart: 2,
        selectionEnd: 2,
      }),
    ).toEqual({ value: "hello", cursor: 3 });
  });

  test("replaces selected text and clamps stale selection offsets", () => {
    expect(
      insertTextAtSelection({
        value: "hello",
        text: "!",
        selectionStart: 4,
        selectionEnd: 99,
      }),
    ).toEqual({ value: "hell!", cursor: 5 });
  });
});

describe("tryClaimComposerFocus", () => {
  afterEach(() => {
    consumePendingComposerFocus();
    document.body.replaceChildren();
  });

  function mountTextarea(): HTMLTextAreaElement {
    const el = document.createElement("textarea");
    document.body.append(el);
    return el;
  }

  test("focuses the textarea after a request", () => {
    const el = mountTextarea();
    requestComposerFocus();
    tryClaimComposerFocus(el);
    expect(document.activeElement).toBe(el);
    expect(isComposerFocusPending()).toBe(true);
  });

  test("reclaims from the document after the original textarea unmounts", () => {
    const first = mountTextarea();
    requestComposerFocus();
    tryClaimComposerFocus(first);
    first.remove();

    const second = mountTextarea();
    tryClaimComposerFocus(second);
    expect(document.activeElement).toBe(second);
  });

  test("stops reclaiming once the user moves to another text field", () => {
    const el = mountTextarea();
    const other = document.createElement("input");
    document.body.append(other);
    requestComposerFocus();
    tryClaimComposerFocus(el);
    other.focus();
    tryClaimComposerFocus(el);
    expect(document.activeElement).toBe(other);
    expect(isComposerFocusPending()).toBe(false);
  });

  test("does not claim when nothing is pending", () => {
    const el = mountTextarea();
    tryClaimComposerFocus(el);
    expect(document.activeElement).not.toBe(el);
  });
});
