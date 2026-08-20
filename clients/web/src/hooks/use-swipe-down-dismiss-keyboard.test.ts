/**
 * Unit tests for the swipe-down-to-dismiss-keyboard gesture.
 *
 * The hook itself is a thin wiring layer over `document` touch listeners; these
 * target the pure decision helpers and the blur action directly, matching how
 * `use-edge-swipe.test.ts` and `use-pull-to-refresh.test.ts` test their hooks.
 */

import { afterEach, describe, expect, test } from "bun:test";

import {
  blurFocusedEditable,
  decideSwipeDown,
  ownsVerticalTextDrag,
  startsOnSelectableText,
} from "@/hooks/use-swipe-down-dismiss-keyboard";

const NO_SELECTION = false;
const LIVE_SELECTION = true;

describe("ownsVerticalTextDrag", () => {
  test("is true for text fields, where a drag places the caret", () => {
    const textarea = document.createElement("textarea");
    expect(ownsVerticalTextDrag(textarea, NO_SELECTION)).toBe(true);
    expect(
      ownsVerticalTextDrag(document.createElement("input"), NO_SELECTION),
    ).toBe(true);
    expect(
      ownsVerticalTextDrag(document.createElement("select"), NO_SELECTION),
    ).toBe(true);
  });

  test("is true inside a contenteditable region", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    const child = document.createElement("span");
    editor.appendChild(child);
    document.body.appendChild(editor);
    expect(ownsVerticalTextDrag(child, NO_SELECTION)).toBe(true);
    editor.remove();
  });

  test("is false for an explicitly non-editable region", () => {
    const region = document.createElement("div");
    region.setAttribute("contenteditable", "false");
    document.body.appendChild(region);
    expect(ownsVerticalTextDrag(region, NO_SELECTION)).toBe(false);
    region.remove();
  });

  test("is false over the transcript, the composer chrome and the header", () => {
    // The point of the gesture: everything above the keyboard answers to it,
    // not just one narrow target.
    const message = document.createElement("div");
    message.setAttribute("data-message-text", "");
    const header = document.createElement("header");
    const toolbarButton = document.createElement("button");
    document.body.append(message, header, toolbarButton);
    expect(ownsVerticalTextDrag(message, NO_SELECTION)).toBe(false);
    expect(ownsVerticalTextDrag(header, NO_SELECTION)).toBe(false);
    expect(ownsVerticalTextDrag(toolbarButton, NO_SELECTION)).toBe(false);
    message.remove();
    header.remove();
    toolbarButton.remove();
  });

  test("yields message text to an in-progress selection drag", () => {
    // Long-press to select, then drag a handle: dismissing here would resize
    // the viewport out from under the selection.
    const message = document.createElement("div");
    message.setAttribute("data-message-text", "");
    const span = document.createElement("span");
    message.appendChild(span);
    document.body.appendChild(message);
    expect(ownsVerticalTextDrag(span, LIVE_SELECTION)).toBe(true);
    message.remove();
  });

  test("keeps chrome outside message text even while a selection is live", () => {
    const header = document.createElement("header");
    document.body.appendChild(header);
    expect(ownsVerticalTextDrag(header, LIVE_SELECTION)).toBe(false);
    header.remove();
  });

  test("is false for a non-element target", () => {
    expect(ownsVerticalTextDrag(null, NO_SELECTION)).toBe(false);
    expect(ownsVerticalTextDrag(document, NO_SELECTION)).toBe(false);
  });
});

describe("startsOnSelectableText", () => {
  test("is true on a message text block and its descendants", () => {
    const message = document.createElement("div");
    message.setAttribute("data-message-text", "");
    const span = document.createElement("span");
    message.appendChild(span);
    document.body.appendChild(message);
    expect(startsOnSelectableText(message)).toBe(true);
    expect(startsOnSelectableText(span)).toBe(true);
    message.remove();
  });

  test("is false off message text, so chrome never waits on a selection", () => {
    const header = document.createElement("header");
    document.body.appendChild(header);
    expect(startsOnSelectableText(header)).toBe(false);
    expect(startsOnSelectableText(null)).toBe(false);
    expect(startsOnSelectableText(document)).toBe(false);
    header.remove();
  });
});

describe("decideSwipeDown", () => {
  test("waits while both axes are inside the deadzone", () => {
    expect(decideSwipeDown(0, 0)).toBe("pending");
    expect(decideSwipeDown(4, 9)).toBe("pending");
  });

  test("tracks a downward drag that has not reached the threshold", () => {
    expect(decideSwipeDown(0, 20)).toBe("tracking");
    expect(decideSwipeDown(0, 39)).toBe("tracking");
  });

  test("dismisses at the threshold and beyond", () => {
    expect(decideSwipeDown(0, 40)).toBe("dismiss");
    expect(decideSwipeDown(0, 200)).toBe("dismiss");
  });

  test("cancels an upward drag, however far it travels", () => {
    expect(decideSwipeDown(0, -40)).toBe("cancel");
    expect(decideSwipeDown(0, -200)).toBe("cancel");
  });

  test("cancels a horizontal-dominant pan so it stays a pan", () => {
    // An attachment strip, a swipe-action row, the edge-swipe drawer.
    expect(decideSwipeDown(60, 20)).toBe("cancel");
    expect(decideSwipeDown(-60, 20)).toBe("cancel");
  });

  test("still dismisses on a diagonal drag that stays vertical-dominant", () => {
    expect(decideSwipeDown(20, 60)).toBe("dismiss");
  });

  test("cancels when a downward drag reverses back upward", () => {
    // Re-evaluated per move, so a drag that dips down and returns past the
    // start does not dismiss on a later frame.
    expect(decideSwipeDown(0, 30)).toBe("tracking");
    expect(decideSwipeDown(0, -12)).toBe("cancel");
  });
});

describe("blurFocusedEditable", () => {
  afterEach(() => {
    document.body.replaceChildren();
  });

  test("blurs a focused text field and reports it", () => {
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    expect(document.activeElement).toBe(input);

    expect(blurFocusedEditable()).toBe(true);
    expect(document.activeElement).not.toBe(input);
  });

  test("blurs a focused contenteditable region", () => {
    const editor = document.createElement("div");
    editor.setAttribute("contenteditable", "true");
    editor.tabIndex = 0;
    document.body.appendChild(editor);
    editor.focus();
    expect(document.activeElement).toBe(editor);

    expect(blurFocusedEditable()).toBe(true);
    expect(document.activeElement).not.toBe(editor);
  });

  test("leaves a focused button alone", () => {
    // A swipe has no business clearing a focus ring, and a button raises no
    // keyboard to dismiss.
    const button = document.createElement("button");
    document.body.appendChild(button);
    button.focus();

    expect(blurFocusedEditable()).toBe(false);
    expect(document.activeElement).toBe(button);
  });

  test("reports false when nothing holds focus", () => {
    expect(blurFocusedEditable()).toBe(false);
  });
});
