import { beforeEach, describe, expect, test } from "bun:test";

import {
  loadPinnedApps,
  savePinnedApps,
  type PinnableApp,
  type PinnedAppEntry,
} from "@/utils/app-pin-storage";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";

/*
 * The environment's own `localStorage`, rather than `installMemoryStorage`.
 * That helper swaps `globalThis.window` for an object carrying nothing but a
 * storage instance, which leaves the window with no `dispatchEvent`. The store
 * follows its key by listening on the window, and a save announcing itself
 * there would be swallowed, so a test file using the helper cannot observe the
 * thing this store does.
 */
beforeEach(() => {
  localStorage.clear();
  // The store is a module singleton whose in-memory slice survives across
  // tests, so reset it alongside storage and start each case empty.
  usePinnedAppsStore.setState({ pinnedApps: [], pinnedAppIds: new Set() });
});

function makeApp(
  overrides: Partial<PinnableApp> & { id: string },
): PinnableApp {
  return {
    name: `App ${overrides.id}`,
    ...overrides,
  };
}

function pin(app: PinnableApp): void {
  usePinnedAppsStore.getState().togglePin(app);
}

/**
 * Write the key without announcing it on the same-tab channel, leaving the
 * cross-tab `StorageEvent` as the only signal a test then fires. Writing
 * through `savePinnedApps` would announce it too, and the store would update
 * before the event was dispatched, so the assertion would hold whether or not
 * the cross-tab listener exists.
 */
function savePinnedAppsSilently(entries: PinnedAppEntry[]): void {
  localStorage.setItem("vellum:pinnedApps", JSON.stringify(entries));
}

describe("togglePin", () => {
  test("pins an unpinned app and reflects it in state + storage", () => {
    pin(makeApp({ id: "a1", name: "First", icon: "🚀" }));

    const state = usePinnedAppsStore.getState();
    expect(state.pinnedAppIds.has("a1")).toBe(true);
    expect(state.pinnedApps).toEqual([
      { appId: "a1", pinnedOrder: 1, name: "First", icon: "🚀" },
    ]);
    expect(loadPinnedApps()).toEqual([
      { appId: "a1", pinnedOrder: 1, name: "First", icon: "🚀" },
    ]);
  });

  test("unpins a pinned app when toggled again", () => {
    pin(makeApp({ id: "a1", name: "First" }));
    usePinnedAppsStore
      .getState()
      .togglePin(makeApp({ id: "a1", name: "First" }));

    expect(usePinnedAppsStore.getState().pinnedAppIds.has("a1")).toBe(false);
    expect(loadPinnedApps()).toEqual([]);
  });
});

describe("unpin", () => {
  test("removes a pin by id — the sidebar's path for a deleted, unloadable app", () => {
    pin(makeApp({ id: "a1", name: "First" }));
    pin(makeApp({ id: "a2", name: "Second" }));

    usePinnedAppsStore.getState().unpin("a1");

    const state = usePinnedAppsStore.getState();
    expect(state.pinnedAppIds.has("a1")).toBe(false);
    expect(state.pinnedApps.map((a) => a.appId)).toEqual(["a2"]);
    expect(loadPinnedApps().map((a) => a.appId)).toEqual(["a2"]);
  });

  test("recompacts order values after removing a middle pin", () => {
    pin(makeApp({ id: "a1" }));
    pin(makeApp({ id: "a2" }));
    pin(makeApp({ id: "a3" }));

    usePinnedAppsStore.getState().unpin("a2");

    expect(
      usePinnedAppsStore.getState().pinnedApps.map((a) => a.pinnedOrder),
    ).toEqual([1, 2]);
    expect(
      usePinnedAppsStore.getState().pinnedApps.map((a) => a.appId),
    ).toEqual(["a1", "a3"]);
  });

  test("notifies onUnpin listeners with the removed app id", () => {
    pin(makeApp({ id: "a1" }));
    const seen: string[] = [];
    const off = usePinnedAppsStore.getState().onUnpin((id) => seen.push(id));

    usePinnedAppsStore.getState().unpin("a1");

    expect(seen).toEqual(["a1"]);
    off();
  });

  test("is a no-op for an id that is not pinned — no state change, no notification", () => {
    pin(makeApp({ id: "a1" }));
    const seen: string[] = [];
    const off = usePinnedAppsStore.getState().onUnpin((id) => seen.push(id));

    usePinnedAppsStore.getState().unpin("ghost");

    expect(seen).toEqual([]);
    expect(
      usePinnedAppsStore.getState().pinnedApps.map((a) => a.appId),
    ).toEqual(["a1"]);
    off();
  });
});

describe("togglePin unpin branch", () => {
  test("also notifies onUnpin listeners", () => {
    pin(makeApp({ id: "a1" }));
    const seen: string[] = [];
    const off = usePinnedAppsStore.getState().onUnpin((id) => seen.push(id));

    usePinnedAppsStore.getState().togglePin(makeApp({ id: "a1" }));

    expect(seen).toEqual(["a1"]);
    off();
  });
});

describe("setColor", () => {
  test("reflects the colour in state and storage", () => {
    pin(makeApp({ id: "a1", name: "First" }));

    usePinnedAppsStore.getState().setColor("a1", "teal");

    expect(usePinnedAppsStore.getState().pinnedApps[0]!.color).toBe("teal");
    expect(loadPinnedApps()[0]!.color).toBe("teal");
  });

  test("clearing drops the colour in state and storage", () => {
    pin(makeApp({ id: "a1", name: "First" }));
    usePinnedAppsStore.getState().setColor("a1", "teal");

    usePinnedAppsStore.getState().setColor("a1", null);

    expect(usePinnedAppsStore.getState().pinnedApps[0]!.color).toBeUndefined();
    expect(loadPinnedApps()[0]!.color).toBeUndefined();
  });

  /* A store slice the sidebar renders from: a colour change has to produce a
     new array, or subscribers keep the reference they already have and the
     pill never repaints. */
  test("publishes a new pinnedApps reference so subscribers re-render", () => {
    pin(makeApp({ id: "a1", name: "First" }));
    const before = usePinnedAppsStore.getState().pinnedApps;

    usePinnedAppsStore.getState().setColor("a1", "teal");

    expect(usePinnedAppsStore.getState().pinnedApps).not.toBe(before);
  });

  test("is a no-op for an id that is not pinned", () => {
    pin(makeApp({ id: "a1", name: "First" }));

    usePinnedAppsStore.getState().setColor("ghost", "teal");

    expect(
      usePinnedAppsStore.getState().pinnedApps.map((a) => a.appId),
    ).toEqual(["a1"]);
    expect(loadPinnedApps().map((a) => a.appId)).toEqual(["a1"]);
  });
});

/**
 * The store follows `vellum:pinnedApps` rather than only its own writes, so a
 * change made anywhere reaches it.
 *
 * `savePinnedApps` stands in for the other tab: it is the same write the other
 * tab's store would perform, and it announces the key the same way. The final
 * case drives a real `StorageEvent` instead, which is the specific listener
 * only a genuinely different tab exercises.
 */
describe("storage subscription", () => {
  test("picks up a pin added outside the store", () => {
    savePinnedApps([{ appId: "a1", pinnedOrder: 1, name: "Elsewhere" }]);

    const state = usePinnedAppsStore.getState();
    expect(state.pinnedApps.map((a) => a.appId)).toEqual(["a1"]);
    expect(state.pinnedAppIds.has("a1")).toBe(true);
  });

  test("picks up a colour changed outside the store", () => {
    pin(makeApp({ id: "a1", name: "First" }));

    savePinnedApps([
      { appId: "a1", pinnedOrder: 1, name: "First", color: "teal" },
    ]);

    expect(usePinnedAppsStore.getState().pinnedApps[0]!.color).toBe("teal");
  });

  test("notifies onUnpin listeners for a pin removed outside the store", () => {
    pin(makeApp({ id: "a1" }));
    pin(makeApp({ id: "a2" }));
    const seen: string[] = [];
    const off = usePinnedAppsStore.getState().onUnpin((id) => seen.push(id));

    savePinnedApps([{ appId: "a2", pinnedOrder: 1, name: "App a2" }]);

    expect(seen).toEqual(["a1"]);
    expect(usePinnedAppsStore.getState().pinnedAppIds.has("a1")).toBe(false);
    off();
  });

  /* A local unpin writes storage, which notifies the subscription, which is
     also what announces the removal. Counted rather than merely observed: the
     action announcing it as well would still leave `seen` containing the id,
     and would fire every listener twice. */
  test("a local unpin notifies its listeners exactly once", () => {
    pin(makeApp({ id: "a1" }));
    const seen: string[] = [];
    const off = usePinnedAppsStore.getState().onUnpin((id) => seen.push(id));

    usePinnedAppsStore.getState().unpin("a1");

    expect(seen).toEqual(["a1"]);
    off();
  });

  test("a pin added outside the store notifies no unpin listener", () => {
    const seen: string[] = [];
    const off = usePinnedAppsStore.getState().onUnpin((id) => seen.push(id));

    savePinnedApps([{ appId: "a1", pinnedOrder: 1, name: "Elsewhere" }]);

    expect(seen).toEqual([]);
    off();
  });

  test("follows a cross-tab StorageEvent for its own key", () => {
    pin(makeApp({ id: "a1" }));

    /* A real cross-tab write: another document mutated the key, so this one
       gets the event with storage already carrying the new value. */
    savePinnedAppsSilently([
      { appId: "a1", pinnedOrder: 1, name: "App a1" },
      { appId: "a2", pinnedOrder: 2, name: "From another tab" },
    ]);
    window.dispatchEvent(
      new StorageEvent("storage", { key: "vellum:pinnedApps" }),
    );

    expect(
      usePinnedAppsStore.getState().pinnedApps.map((a) => a.appId),
    ).toEqual(["a1", "a2"]);
  });

  /* Six consumers select `pinnedAppIds` to ask whether one app is pinned, and
     a fresh Set on every notification re-renders all of them against a set
     holding exactly what it held before. Asserted by reference rather than by
     contents, which would be equal either way. */
  test("a notification carrying no change publishes no new state", () => {
    pin(makeApp({ id: "a1" }));
    const before = usePinnedAppsStore.getState();

    savePinnedApps(loadPinnedApps());

    const after = usePinnedAppsStore.getState();
    expect(after.pinnedApps).toBe(before.pinnedApps);
    expect(after.pinnedAppIds).toBe(before.pinnedAppIds);
  });

  test("ignores a StorageEvent for an unrelated key", () => {
    pin(makeApp({ id: "a1" }));

    savePinnedAppsSilently([]);
    window.dispatchEvent(
      new StorageEvent("storage", { key: "vellum:somethingElse" }),
    );

    expect(
      usePinnedAppsStore.getState().pinnedApps.map((a) => a.appId),
    ).toEqual(["a1"]);
  });
});

describe("isPinned", () => {
  test("tracks pin/unpin transitions", () => {
    expect(usePinnedAppsStore.getState().isPinned("a1")).toBe(false);
    pin(makeApp({ id: "a1" }));
    expect(usePinnedAppsStore.getState().isPinned("a1")).toBe(true);
    usePinnedAppsStore.getState().unpin("a1");
    expect(usePinnedAppsStore.getState().isPinned("a1")).toBe(false);
  });
});
