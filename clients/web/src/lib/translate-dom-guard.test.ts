import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";

import { installTranslateDomGuard } from "@/lib/translate-dom-guard";

const originalRemoveChild = Node.prototype.removeChild;
const originalInsertBefore = Node.prototype.insertBefore;

/**
 * The common Google Translate case: a text node is wrapped in place, so the
 * wrapper (Chrome uses `<font>`; type is irrelevant here) becomes a child of
 * the original parent and the text node lives one level down. React still holds
 * the original text-node reference.
 */
function wrappedInPlace(): { parent: HTMLElement; text: Text; wrapper: HTMLElement } {
  const parent = document.createElement("div");
  const text = document.createTextNode("translated");
  parent.appendChild(text);
  document.body.appendChild(parent);

  const wrapper = document.createElement("span");
  originalRemoveChild.call(parent, text);
  wrapper.appendChild(text);
  parent.appendChild(wrapper);

  return { parent, text, wrapper };
}

/**
 * The rarer case: the translator moves the node out from under its original
 * parent entirely, so it is no longer recoverable from `parent`.
 */
function movedAway(): { parent: HTMLElement; orphan: Text } {
  const parent = document.createElement("div");
  const orphan = document.createTextNode("translated");
  parent.appendChild(orphan);
  document.body.appendChild(parent);

  originalRemoveChild.call(parent, orphan);
  const elsewhere = document.createElement("span");
  document.body.appendChild(elsewhere);
  elsewhere.appendChild(orphan);

  return { parent, orphan };
}

describe("translate-dom-guard", () => {
  beforeAll(() => {
    installTranslateDomGuard();
  });

  afterAll(() => {
    Node.prototype.removeChild = originalRemoveChild;
    Node.prototype.insertBefore = originalInsertBefore;
  });

  test("removeChild removes the in-place translation wrapper so the label disappears", () => {
    const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
    const { parent, text, wrapper } = wrappedInPlace();

    expect(() => parent.removeChild(text)).not.toThrow();
    expect(parent.contains(wrapper)).toBe(false);
    expect(parent.textContent).toBe("");
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  test("removeChild no-ops when the node was moved out of the parent entirely", () => {
    const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
    const { parent, orphan } = movedAway();

    expect(() => parent.removeChild(orphan)).not.toThrow();
    expect(parent.removeChild(orphan)).toBe(orphan);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  test("insertBefore inserts before the in-place wrapper, preserving order", () => {
    const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
    const { parent, text, wrapper } = wrappedInPlace();
    const inserted = document.createElement("i");

    // React wants `inserted` before the (now-wrapped) text node.
    expect(() => parent.insertBefore(inserted, text)).not.toThrow();
    expect(inserted.parentNode).toBe(parent);
    expect(parent.firstChild).toBe(inserted);
    expect(inserted.nextSibling).toBe(wrapper);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  test("insertBefore appends when the reference was moved out of the parent entirely", () => {
    const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
    const { parent, orphan } = movedAway();
    const inserted = document.createElement("span");

    expect(() => parent.insertBefore(inserted, orphan)).not.toThrow();
    expect(inserted.parentNode).toBe(parent);
    expect(parent.lastChild).toBe(inserted);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  test("normal removeChild / insertBefore still work", () => {
    const parent = document.createElement("div");
    const a = document.createElement("span");
    const b = document.createElement("span");
    parent.appendChild(b);

    parent.insertBefore(a, b);
    expect(parent.firstChild).toBe(a);

    parent.removeChild(a);
    expect(parent.contains(a)).toBe(false);
    expect(parent.firstChild).toBe(b);
  });

  test("is idempotent — repeated installs do not re-wrap", () => {
    const before = Node.prototype.removeChild;
    installTranslateDomGuard();
    expect(Node.prototype.removeChild).toBe(before);
  });
});
