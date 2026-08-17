import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { DiffRows, type DiffRow } from "./diff-rows";

afterEach(cleanup);

const ROWS: DiffRow[] = [
  { type: "ctx", text: "unchanged", oldNo: 3, newNo: 3 },
  { type: "del", text: "removed", oldNo: 4 },
  { type: "add", text: "added", newNo: 4 },
  { type: "meta", text: "@@ -10,3 +10,3 @@" },
];

function row(container: HTMLElement, type: string): HTMLElement {
  const el = container.querySelector<HTMLElement>(`[data-diff-type="${type}"]`);
  if (!el) {
    throw new Error(`no ${type} row`);
  }
  return el;
}

/** [old-side, new-side] gutter cell text for one rendered row. */
function gutter(rowEl: HTMLElement): [string, string] {
  const cells = rowEl.querySelectorAll("span");
  return [cells[0]?.textContent ?? "", cells[1]?.textContent ?? ""];
}

describe("DiffRows", () => {
  test("absent-side gutter cells are empty, present side shows the number", () => {
    const { container } = render(<DiffRows rows={ROWS} />);

    expect(gutter(row(container, "ctx"))).toEqual(["3", "3"]);
    // The +/- marker column carries the add/del signal; the absent-side
    // number cell stays blank (no placeholder dash), matching GitHub.
    expect(gutter(row(container, "del"))).toEqual(["4", ""]);
    expect(gutter(row(container, "add"))).toEqual(["", "4"]);
  });

  test("rows soft-wrap instead of forcing horizontal scroll", () => {
    const { container } = render(<DiffRows rows={ROWS} />);

    for (const type of ["ctx", "del", "add"]) {
      const rowEl = row(container, type);
      expect(rowEl.className).toContain("whitespace-pre-wrap");
      const text = rowEl.querySelector("span:last-of-type");
      expect(text?.className).toContain("break-words");
      expect(text?.className).toContain("min-w-0");
    }
  });

  test("meta rows render the hunk-gap separator, not their header text", () => {
    const { container } = render(<DiffRows rows={ROWS} />);

    const meta = row(container, "meta");
    expect(meta.textContent).toBe("⋯");
    expect(meta.getAttribute("aria-hidden")).toBe("true");
  });

  test("marker column distinguishes add and del", () => {
    const { container } = render(<DiffRows rows={ROWS} />);

    expect(row(container, "add").textContent).toContain("+added");
    expect(row(container, "del").textContent).toContain("-removed");
  });
});
