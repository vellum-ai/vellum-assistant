/**
 * Tests for the pure reorder computation behind sidebar drag-and-drop.
 * The DOM event wiring in `useDragReorder` is exercised manually; the
 * order math is what must stay correct.
 */

import { describe, expect, test } from "bun:test";

import { reorderByDrop } from "@/domains/chat/hooks/use-drag-reorder";

type Item = { id: string };

const items: Item[] = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
const getId = (item: Item) => item.id;
const ids = (result: Item[] | null) => result?.map((i) => i.id) ?? null;

describe("reorderByDrop", () => {
  test("moves an item down, dropping after the target", () => {
    expect(ids(reorderByDrop(items, getId, "a", "c", "after"))).toEqual([
      "b",
      "c",
      "a",
      "d",
    ]);
  });

  test("moves an item up, dropping before the target", () => {
    expect(ids(reorderByDrop(items, getId, "d", "b", "before"))).toEqual([
      "a",
      "d",
      "b",
      "c",
    ]);
  });

  test("moves to the very top and very bottom", () => {
    expect(ids(reorderByDrop(items, getId, "c", "a", "before"))).toEqual([
      "c",
      "a",
      "b",
      "d",
    ]);
    expect(ids(reorderByDrop(items, getId, "a", "d", "after"))).toEqual([
      "b",
      "c",
      "d",
      "a",
    ]);
  });

  test("returns null when dropped on itself", () => {
    expect(reorderByDrop(items, getId, "b", "b", "before")).toBeNull();
  });

  test("returns null when the resulting order is unchanged", () => {
    expect(reorderByDrop(items, getId, "b", "a", "after")).toBeNull();
    expect(reorderByDrop(items, getId, "b", "c", "before")).toBeNull();
  });

  test("returns null when source or target is not in the list", () => {
    expect(reorderByDrop(items, getId, "missing", "a", "before")).toBeNull();
    expect(reorderByDrop(items, getId, "a", "missing", "before")).toBeNull();
  });

  test("does not mutate the input list", () => {
    const before = [...items];
    reorderByDrop(items, getId, "a", "c", "after");
    expect(items).toEqual(before);
  });
});
