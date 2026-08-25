/**
 * `keepFocusedFieldVisible` scrolls a focused text field inside the given
 * container just far enough to stay on screen, and reports whether it acted.
 * Focus outside the container, on a non-text element, or nowhere leaves the
 * viewport untouched.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { keepFocusedFieldVisible } from "./focused-field";

/** happy-dom does not implement `scrollIntoView`, so record calls per element. */
function trackScrollIntoView(el: HTMLElement) {
  const calls: ScrollIntoViewOptions[] = [];
  el.scrollIntoView = ((opts?: ScrollIntoViewOptions) => {
    calls.push(opts ?? {});
  }) as HTMLElement["scrollIntoView"];
  return calls;
}

describe("keepFocusedFieldVisible", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.innerHTML = "";
  });

  test("scrolls a focused field inside the container into view", () => {
    const input = document.createElement("input");
    container.appendChild(input);
    const calls = trackScrollIntoView(input);

    input.focus();

    expect(keepFocusedFieldVisible(container)).toBe(true);
    expect(calls).toEqual([{ block: "nearest", behavior: "auto" }]);
  });

  test("leaves a field focused outside the container alone", () => {
    const outside = document.createElement("input");
    document.body.appendChild(outside);
    const calls = trackScrollIntoView(outside);

    outside.focus();

    expect(keepFocusedFieldVisible(container)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("ignores a focused element that owns no caret", () => {
    const button = document.createElement("button");
    container.appendChild(button);
    const calls = trackScrollIntoView(button);

    button.focus();

    expect(keepFocusedFieldVisible(container)).toBe(false);
    expect(calls).toHaveLength(0);
  });

  test("reports false with nothing focused", () => {
    expect(keepFocusedFieldVisible(container)).toBe(false);
  });

  test("reports false when the container is absent", () => {
    const input = document.createElement("input");
    container.appendChild(input);
    input.focus();

    expect(keepFocusedFieldVisible(null)).toBe(false);
  });
});
