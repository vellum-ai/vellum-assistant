import { describe, expect, test } from "bun:test";

import { computeLineDiff, type DiffRow } from "./compute-line-diff";

function types(rows: DiffRow[]): string[] {
  return rows.map((r) => r.type);
}

describe("computeLineDiff", () => {
  test("identical text → all context rows with both line numbers", () => {
    const rows = computeLineDiff("a\nb\nc", "a\nb\nc");
    expect(types(rows)).toEqual(["ctx", "ctx", "ctx"]);
    expect(rows[0]).toEqual({ type: "ctx", text: "a", oldNo: 1, newNo: 1 });
    expect(rows[2]).toEqual({ type: "ctx", text: "c", oldNo: 3, newNo: 3 });
  });

  test("new file (empty old) → all additions", () => {
    const rows = computeLineDiff("", "x\ny");
    expect(types(rows)).toEqual(["add", "add"]);
    expect(rows[0]).toEqual({ type: "add", text: "x", newNo: 1 });
    expect(rows[1]).toEqual({ type: "add", text: "y", newNo: 2 });
    expect(rows.every((r) => r.oldNo === undefined)).toBe(true);
  });

  test("deleted file (empty new) → all deletions", () => {
    const rows = computeLineDiff("x\ny", "");
    expect(types(rows)).toEqual(["del", "del"]);
    expect(rows[0]).toEqual({ type: "del", text: "x", oldNo: 1 });
    expect(rows[1]).toEqual({ type: "del", text: "y", oldNo: 2 });
    expect(rows.every((r) => r.newNo === undefined)).toBe(true);
  });

  test("modify in the middle → context preserved, changed line del+add", () => {
    const rows = computeLineDiff("a\nb\nc", "a\nB\nc");
    expect(types(rows)).toEqual(["ctx", "del", "add", "ctx"]);
    expect(rows[1]).toMatchObject({ type: "del", text: "b", oldNo: 2 });
    expect(rows[2]).toMatchObject({ type: "add", text: "B", newNo: 2 });
    expect(rows[3]).toMatchObject({ type: "ctx", text: "c", oldNo: 3, newNo: 3 });
  });

  test("pure insertion keeps surrounding context", () => {
    const rows = computeLineDiff("a\nc", "a\nb\nc");
    expect(types(rows)).toEqual(["ctx", "add", "ctx"]);
    expect(rows[1]).toMatchObject({ type: "add", text: "b", newNo: 2 });
  });

  test("pure deletion keeps surrounding context", () => {
    const rows = computeLineDiff("a\nb\nc", "a\nc");
    expect(types(rows)).toEqual(["ctx", "del", "ctx"]);
    expect(rows[1]).toMatchObject({ type: "del", text: "b", oldNo: 2 });
  });

  test("both empty → no rows", () => {
    expect(computeLineDiff("", "")).toEqual([]);
  });

  test("oversized input → single too-large sentinel row", () => {
    const huge = Array.from({ length: 2001 }, (_, i) => `line ${i}`).join("\n");
    const rows = computeLineDiff(huge, "a");
    expect(rows).toHaveLength(1);
    expect(rows[0].type).toBe("too-large");
    expect(rows[0].text).toMatch(/too large/i);
  });
});
