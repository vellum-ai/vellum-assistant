import { afterAll, beforeAll, describe, expect, mock, spyOn, test } from "bun:test";

import { installTranslateDomGuard } from "@/lib/translate-dom-guard";

const originalRemoveChild = Node.prototype.removeChild;
const originalInsertBefore = Node.prototype.insertBefore;

/**
 * Simulate what a page translator does: detach a text node from its parent and
 * re-parent it under a wrapper the translator inserts (Chrome uses `<font>`;
 * the element type is irrelevant here — only the re-parenting matters).
 * React still holds a reference to the detached node and later asks its former
 * parent to remove or insert around it.
 */
function reparentedNode(): { parent: HTMLElement; orphan: Text } {
  const parent = document.createElement("div");
  const orphan = document.createTextNode("translated");
  parent.appendChild(orphan);
  document.body.appendChild(parent);

  const wrapper = document.createElement("span");
  document.body.appendChild(wrapper);
  originalRemoveChild.call(parent, orphan);
  wrapper.appendChild(orphan);

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

  test("removeChild no-ops instead of throwing when the child was re-parented", () => {
    const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
    const { parent, orphan } = reparentedNode();

    expect(() => parent.removeChild(orphan)).not.toThrow();
    expect(parent.removeChild(orphan)).toBe(orphan);
    expect(warn).toHaveBeenCalled();

    warn.mockRestore();
  });

  test("insertBefore appends instead of throwing when the reference was re-parented", () => {
    const warn = spyOn(console, "warn").mockImplementation(mock(() => {}));
    const { parent, orphan } = reparentedNode();
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
