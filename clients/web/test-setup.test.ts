/**
 * Guards the focus re-entrancy shim in `test-setup.ts`.
 *
 * Note the failure mode: if the shim is removed, these do not go red: they
 * hang, because the underlying happy-dom bug is a synchronous loop. That is
 * exactly why the shim exists, and why this file documents the invariant
 * rather than relying on a red test to catch a regression.
 */

import { afterEach, describe, expect, test } from "bun:test";

describe("focus re-entrancy shim", () => {
  const created: HTMLElement[] = [];

  function button(id: string): HTMLButtonElement {
    const el = document.createElement("button");
    el.id = id;
    document.body.appendChild(el);
    created.push(el);
    return el;
  }

  afterEach(() => {
    for (const el of created.splice(0)) {
      el.remove();
    }
  });

  test("two elements that refocus each other on blur settle instead of looping", () => {
    // The shape Radix produces inside a Dialog: the focus scope pulls focus
    // back to the trigger, the overlay sends it to its option, repeat.
    const trigger = button("trigger");
    const option = button("option");
    let focusEvents = 0;

    trigger.addEventListener("blur", () => option.focus());
    option.addEventListener("blur", () => trigger.focus());
    trigger.addEventListener("focus", () => {
      focusEvents += 1;
    });
    option.addEventListener("focus", () => {
      focusEvents += 1;
    });

    trigger.focus();
    option.focus();

    // Bounded is the whole assertion: unguarded this never returns.
    expect(focusEvents).toBeLessThan(10);
    expect(focusEvents).toBeGreaterThan(0);
  });

  test("focusing a different element from a blur handler still works", () => {
    // The shim must not suppress legitimate focus moves, only re-entrant ones.
    const first = button("first");
    const second = button("second");
    first.addEventListener("blur", () => second.focus());

    first.focus();
    expect(document.activeElement).toBe(first);

    first.blur();
    expect(document.activeElement).toBe(second);
  });

  test("a plain focus still sets activeElement", () => {
    const el = button("plain");
    el.focus();
    expect(document.activeElement).toBe(el);
  });
});
