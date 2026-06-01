import { describe, expect, test } from "bun:test";

import { WorkingSet } from "../working-set.js";

describe("WorkingSet (skeleton)", () => {
  test("recording a selection adds it to union()", () => {
    const ws = new WorkingSet();
    ws.recordSelection("alpha", 1, false);

    expect(ws.union().has("alpha")).toBe(true);
    expect(ws.size()).toBe(1);
  });

  test("recording the same slug twice preserves selectedAtTurn and updates lastSeenTurn", () => {
    const ws = new WorkingSet();
    ws.recordSelection("alpha", 1, false);
    ws.recordSelection("alpha", 5, false);

    expect(ws.size()).toBe(1);
    const entry = [...ws.union()];
    expect(entry).toEqual(["alpha"]);
    // selectedAtTurn preserved at original turn, lastSeenTurn advanced.
    const internal = (
      ws as unknown as {
        entries: Map<string, { selectedAtTurn: number; lastSeenTurn: number }>;
      }
    ).entries.get("alpha");
    expect(internal?.selectedAtTurn).toBe(1);
    expect(internal?.lastSeenTurn).toBe(5);
  });

  test("pinned propagates: non-pinned then pinned keeps pinned true", () => {
    const ws = new WorkingSet();
    ws.recordSelection("alpha", 1, false);
    ws.recordSelection("alpha", 2, true);

    const internal = (
      ws as unknown as {
        entries: Map<string, { pinned: boolean }>;
      }
    ).entries.get("alpha");
    expect(internal?.pinned).toBe(true);
  });
});
