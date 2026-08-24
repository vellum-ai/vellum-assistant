import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import {
  listAppPins,
  removeAppPin,
  updateAppPin,
} from "../apps/app-pin-store.js";

let testDataDir: string;

function freshTempDir(): string {
  return join(
    tmpdir(),
    `vellum-app-pin-test-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
}

/** Write the pins file directly, standing in for state an earlier build left. */
function seedPinsFile(contents: string): void {
  const dataDir = join(testDataDir, "data");
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, "app-pins.json"), contents);
}

function pin(appId: string): void {
  updateAppPin(appId, { pinned: true });
}

function orderOf(): [string, number][] {
  return listAppPins().map((entry) => [entry.appId, entry.pinnedOrder]);
}

beforeEach(() => {
  testDataDir = freshTempDir();
  process.env.VELLUM_WORKSPACE_DIR = testDataDir;
});

afterEach(() => {
  if (existsSync(testDataDir)) {
    rmSync(testDataDir, { recursive: true, force: true });
  }
});

describe("pinning", () => {
  test("appends each new pin after the last, 1-based", () => {
    pin("a");
    pin("b");
    pin("c");

    expect(orderOf()).toEqual([
      ["a", 1],
      ["b", 2],
      ["c", 3],
    ]);
  });

  test("pinning an already-pinned app leaves its position alone", () => {
    pin("a");
    pin("b");

    pin("a");

    expect(orderOf()).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  test("reports the resulting pin, and null once unpinned", () => {
    expect(updateAppPin("a", { pinned: true })).toEqual({
      appId: "a",
      pinnedOrder: 1,
    });
    expect(updateAppPin("a", { pinned: false })).toBeNull();
  });

  test("an unpin with nothing pinned is a no-op, not a throw", () => {
    expect(updateAppPin("ghost", { pinned: false })).toBeNull();
    expect(listAppPins()).toEqual([]);
  });
});

/*
 * `pinnedOrder` is a position, not a counter. Asserted by value rather than by
 * relative order, which would hold just as well for the 1, 3, 4 an unpin leaves
 * behind if the gap were never closed. A gap makes the next pin collide with an
 * existing position once the count catches up.
 */
describe("unpinning", () => {
  test("closes the gap left in the middle of the list", () => {
    pin("a");
    pin("b");
    pin("c");

    updateAppPin("b", { pinned: false });

    expect(orderOf()).toEqual([
      ["a", 1],
      ["c", 2],
    ]);
  });

  test("a pin taken after an unpin lands after the survivors, not on one", () => {
    pin("a");
    pin("b");
    updateAppPin("a", { pinned: false });

    pin("c");

    expect(orderOf()).toEqual([
      ["b", 1],
      ["c", 2],
    ]);
  });

  test("removeAppPin drops the pin and recompacts", () => {
    pin("a");
    pin("b");

    removeAppPin("a");

    expect(orderOf()).toEqual([["b", 1]]);
  });

  test("removeAppPin for an unpinned app changes nothing", () => {
    pin("a");

    removeAppPin("ghost");

    expect(orderOf()).toEqual([["a", 1]]);
  });
});

describe("colour", () => {
  test("sets and clears without disturbing the position", () => {
    pin("a");
    pin("b");

    updateAppPin("b", { color: "teal" });
    expect(listAppPins()[1]).toEqual({
      appId: "b",
      pinnedOrder: 2,
      color: "teal",
    });

    updateAppPin("b", { color: null });
    expect(listAppPins()[1]).toEqual({ appId: "b", pinnedOrder: 2 });
  });

  test("survives a later pin call that says nothing about colour", () => {
    pin("a");
    updateAppPin("a", { color: "teal" });

    updateAppPin("a", { pinned: true });

    expect(listAppPins()[0]?.color).toBe("teal");
  });

  /* Otherwise a colour set on an app the user just unpinned would put the pin
     back, and the sidebar would grow a row nobody asked for. */
  test("a colour for an unpinned app creates no pin", () => {
    expect(updateAppPin("ghost", { color: "teal" })).toBeNull();
    expect(listAppPins()).toEqual([]);
  });

  test("unpinning takes the colour with it", () => {
    pin("a");
    updateAppPin("a", { color: "teal" });

    updateAppPin("a", { pinned: false });
    pin("a");

    expect(listAppPins()[0]).toEqual({ appId: "a", pinnedOrder: 1 });
  });
});

/*
 * A pin list is a preference. One bad entry must cost the user that entry and
 * nothing else, so every case here asserts what survives rather than only that
 * the read did not throw.
 */
describe("reading a damaged file", () => {
  test("drops malformed entries and keeps the rest, renumbered", () => {
    seedPinsFile(
      JSON.stringify([
        { appId: "a", pinnedOrder: 1 },
        { appId: 42, pinnedOrder: 2 },
        { pinnedOrder: 3 },
        { appId: "d", pinnedOrder: 4, color: 7 },
        { appId: "e", pinnedOrder: 5, color: "teal" },
      ]),
    );

    expect(listAppPins()).toEqual([
      { appId: "a", pinnedOrder: 1 },
      { appId: "e", pinnedOrder: 2, color: "teal" },
    ]);
  });

  test("unparseable JSON reads as no pins", () => {
    seedPinsFile("{not json");
    expect(listAppPins()).toEqual([]);
  });

  test("a JSON value that is not an array reads as no pins", () => {
    seedPinsFile('{"appId":"a"}');
    expect(listAppPins()).toEqual([]);
  });

  test("a missing file reads as no pins", () => {
    expect(listAppPins()).toEqual([]);
  });

  /* Two pins on one position is a state no writer produces, so it can only
     arrive from a damaged file. Left alone it would render one app twice. */
  test("duplicate ids collapse to the first, keeping order contiguous", () => {
    seedPinsFile(
      JSON.stringify([
        { appId: "a", pinnedOrder: 1 },
        { appId: "a", pinnedOrder: 2 },
        { appId: "b", pinnedOrder: 2 },
      ]),
    );

    expect(orderOf()).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });

  test("out-of-order and gapped positions are renumbered on read", () => {
    seedPinsFile(
      JSON.stringify([
        { appId: "b", pinnedOrder: 40 },
        { appId: "a", pinnedOrder: 9 },
      ]),
    );

    expect(orderOf()).toEqual([
      ["a", 1],
      ["b", 2],
    ]);
  });
});
