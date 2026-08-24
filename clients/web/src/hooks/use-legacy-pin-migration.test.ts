import { beforeEach, describe, expect, test } from "bun:test";

import {
  planLegacyPinClaim,
  readLegacyPins,
  writeLegacyPins,
  type LegacyPin,
} from "@/hooks/use-legacy-pin-migration";

const LEGACY_KEY = "vellum:pinnedApps";

function app(id: string, pinSortPosition?: number) {
  return pinSortPosition === undefined ? { id } : { id, pinSortPosition };
}

function legacyPin(appId: string, pinnedOrder: number, color?: string) {
  return color === undefined
    ? { appId, pinnedOrder }
    : { appId, pinnedOrder, color };
}

beforeEach(() => {
  localStorage.clear();
});

/*
 * The legacy key held one list for the whole browser, so its contents are a
 * union of pins from every assistant the user opened. These cases are about
 * what the migration refuses to move, which is the part that decides whether
 * the upgrade cleans the state up or launders it.
 */
describe("planLegacyPinClaim", () => {
  test("claims only ids this assistant has an app for", () => {
    const legacy = [
      legacyPin("mine-1", 1),
      legacyPin("someone-elses", 2),
      legacyPin("mine-2", 3),
    ];

    const claimed = planLegacyPinClaim(legacy, [
      app("mine-1"),
      app("mine-2"),
      app("never-pinned"),
    ]);

    expect(claimed.map((pin) => pin.appId)).toEqual(["mine-1", "mine-2"]);
  });

  /* The whole reason the key is left in place rather than deleted after the
     first claim: the entries another assistant owns have to survive for it. */
  test("leaves another assistant's ids for that assistant", () => {
    const legacy = [legacyPin("a-app", 1), legacyPin("b-app", 2)];

    expect(planLegacyPinClaim(legacy, [app("a-app")])).toEqual([
      legacyPin("a-app", 1),
    ]);
    expect(planLegacyPinClaim(legacy, [app("b-app")])).toEqual([
      legacyPin("b-app", 2),
    ]);
  });

  /* Asserted as nothing claimed rather than as "only the new one claimed":
     merging even one distrusted entry into a curated list is the failure. */
  test("claims nothing when the assistant already has a pin of its own", () => {
    const legacy = [legacyPin("mine-1", 1)];

    expect(
      planLegacyPinClaim(legacy, [app("mine-1"), app("already", 1)]),
    ).toEqual([]);
  });

  test("an id whose app was deleted is never claimed", () => {
    expect(
      planLegacyPinClaim([legacyPin("deleted", 1)], [app("other")]),
    ).toEqual([]);
  });

  test("claims in stored order, not in the order the app list happens to be in", () => {
    const legacy = [legacyPin("third", 30), legacyPin("first", 10)];

    const claimed = planLegacyPinClaim(legacy, [app("first"), app("third")]);

    expect(claimed.map((pin) => pin.appId)).toEqual(["first", "third"]);
  });

  test("carries the colour across with the pin", () => {
    const claimed = planLegacyPinClaim(
      [legacyPin("mine", 1, "teal")],
      [app("mine")],
    );

    expect(claimed[0]?.color).toBe("teal");
  });

  test("an empty legacy list claims nothing", () => {
    expect(planLegacyPinClaim([], [app("mine")])).toEqual([]);
  });

  test("an assistant with no apps claims nothing", () => {
    expect(planLegacyPinClaim([legacyPin("mine", 1)], [])).toEqual([]);
  });
});

describe("readLegacyPins", () => {
  test("reads the stored list", () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([legacyPin("a", 1, "teal")]),
    );

    expect(readLegacyPins()).toEqual([legacyPin("a", 1, "teal")]);
  });

  test("drops malformed entries and keeps the rest", () => {
    localStorage.setItem(
      LEGACY_KEY,
      JSON.stringify([
        { appId: "keep", pinnedOrder: 1 },
        { appId: "", pinnedOrder: 2 },
        { appId: "no-order" },
        { appId: "bad-colour", pinnedOrder: 3, color: 7 },
      ]),
    );

    expect(readLegacyPins().map((pin) => pin.appId)).toEqual(["keep"]);
  });

  test("an absent key, unparseable JSON, or a non-array all read as empty", () => {
    expect(readLegacyPins()).toEqual([]);

    localStorage.setItem(LEGACY_KEY, "{not json");
    expect(readLegacyPins()).toEqual([]);

    localStorage.setItem(LEGACY_KEY, '{"appId":"a"}');
    expect(readLegacyPins()).toEqual([]);
  });
});

describe("writeLegacyPins", () => {
  test("keeps what is still unclaimed", () => {
    const remaining: LegacyPin[] = [legacyPin("theirs", 2)];

    writeLegacyPins(remaining);

    expect(readLegacyPins()).toEqual(remaining);
  });

  /* The key must not outlive its contents: left behind empty it is one more
     unscoped pin key sitting in storage for the next reader to misread. */
  test("removes the key once nothing is left to claim", () => {
    localStorage.setItem(LEGACY_KEY, JSON.stringify([legacyPin("a", 1)]));

    writeLegacyPins([]);

    expect(localStorage.getItem(LEGACY_KEY)).toBeNull();
  });
});
