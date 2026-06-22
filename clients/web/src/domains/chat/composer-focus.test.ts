import { describe, expect, test } from "bun:test";

import {
  insertTextAtSelection,
  shouldFocusComposerForTyping,
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
