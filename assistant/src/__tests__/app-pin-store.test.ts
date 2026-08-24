import { beforeEach, describe, expect, test } from "bun:test";

import {
  listAppPins,
  removeAppPin,
  updateAppPin,
} from "../apps/app-pin-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { appPins } from "../persistence/schema/index.js";

await initializeDb();

function pin(appId: string): void {
  updateAppPin(appId, { pinned: true });
}

function order(): string[] {
  return listAppPins().map((entry) => entry.appId);
}

function positionOf(appId: string): number | undefined {
  return listAppPins().find((entry) => entry.appId === appId)?.sortPosition;
}

beforeEach(() => {
  getDb().delete(appPins).run();
});

describe("pinning", () => {
  test("appends each new pin after the last", () => {
    pin("a");
    pin("b");
    pin("c");

    expect(order()).toEqual(["a", "b", "c"]);
  });

  test("pinning an already-pinned app leaves its position alone", () => {
    pin("a");
    pin("b");
    const before = positionOf("a");

    pin("a");

    expect(positionOf("a")).toBe(before!);
    expect(order()).toEqual(["a", "b"]);
  });

  test("reports the resulting pin, and null once unpinned", () => {
    expect(updateAppPin("a", { pinned: true })).toMatchObject({ appId: "a" });
    expect(updateAppPin("a", { pinned: false })).toBeNull();
  });

  test("an unpin with nothing pinned is a no-op, not a throw", () => {
    expect(updateAppPin("ghost", { pinned: false })).toBeNull();
    expect(listAppPins()).toEqual([]);
  });
});

/*
 * Positions are a fractional index, so removing one leaves the others exactly
 * where they were. Asserted by value rather than by relative order, which would
 * hold either way and would not catch a rewrite that renumbers the survivors.
 */
describe("unpinning", () => {
  test("leaves the surviving positions untouched", () => {
    pin("a");
    pin("b");
    pin("c");
    const positions = { a: positionOf("a"), c: positionOf("c") };

    updateAppPin("b", { pinned: false });

    expect(order()).toEqual(["a", "c"]);
    expect(positionOf("a")).toBe(positions.a!);
    expect(positionOf("c")).toBe(positions.c!);
  });

  test("a pin taken after an unpin lands last, not on a survivor", () => {
    pin("a");
    pin("b");
    updateAppPin("a", { pinned: false });

    pin("c");

    expect(order()).toEqual(["b", "c"]);
    expect(positionOf("c")).toBeGreaterThan(positionOf("b")!);
  });

  test("removeAppPin drops the pin", () => {
    pin("a");
    pin("b");

    removeAppPin("a");

    expect(order()).toEqual(["b"]);
  });

  test("removeAppPin for an unpinned app changes nothing", () => {
    pin("a");

    removeAppPin("ghost");

    expect(order()).toEqual(["a"]);
  });
});

describe("colour", () => {
  test("sets and clears without disturbing the position", () => {
    pin("a");
    pin("b");
    const before = positionOf("b");

    updateAppPin("b", { color: "teal" });
    expect(listAppPins()[1]?.color).toBe("teal");
    expect(positionOf("b")).toBe(before!);

    updateAppPin("b", { color: null });
    expect(listAppPins()[1]?.color).toBeUndefined();
    expect(positionOf("b")).toBe(before!);
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

    expect(listAppPins()[0]?.color).toBeUndefined();
  });
});
