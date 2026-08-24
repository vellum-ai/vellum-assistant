import { describe, expect, test } from "bun:test";

import { planLegacyPinClaim } from "@/hooks/use-legacy-pin-migration";

function app(id: string, pinSortPosition?: number) {
  return pinSortPosition === undefined
    ? { id, origin: "workspace" }
    : { id, origin: "workspace", pinSortPosition };
}

/** An app a plugin ships. Its id is shared by every assistant with that plugin. */
function pluginApp(plugin: string, appDir: string) {
  return { id: `plugins~${plugin}~${appDir}`, origin: `plugin:${plugin}` };
}

function legacyPin(appId: string, pinnedOrder: number, color?: string) {
  return {
    appId,
    pinnedOrder,
    name: `App ${appId}`,
    ...(color === undefined ? {} : { color }),
  };
}

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

  /*
   * A plugin app's id is `plugins~<plugin>~<appDir>`, so every assistant with
   * that plugin reports it. Presence proves the app is here, never that the pin
   * was made here, and claiming one would write another assistant's pin to this
   * daemon: the cross-assistant leak this migration exists to end, made durable.
   */
  test("never claims a plugin app, whose id every assistant shares", () => {
    const pin = legacyPin("plugins~demo~widget", 1);

    expect(planLegacyPinClaim([pin], [pluginApp("demo", "widget")])).toEqual([]);
  });

  test("claims the workspace apps beside an unclaimable plugin app", () => {
    const claimed = planLegacyPinClaim(
      [legacyPin("plugins~demo~widget", 1), legacyPin("mine", 2)],
      [pluginApp("demo", "widget"), app("mine")],
    );

    expect(claimed.map((pin) => pin.appId)).toEqual(["mine"]);
  });

  /* An older cached response carries no origin, so nothing about it is
     attributable and the conservative answer is to leave it. */
  test("never claims an app whose origin is unknown", () => {
    expect(planLegacyPinClaim([legacyPin("mine", 1)], [{ id: "mine" }])).toEqual(
      [],
    );
  });
});
