import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { loadPinnedApps, type PinnableApp } from "@/utils/app-pin-storage";
import { installMemoryStorage } from "@/utils/memory-storage.test-helper";
import { usePinnedAppsStore } from "@/stores/pinned-apps-store";

installMemoryStorage({ beforeAll, afterAll, beforeEach, afterEach });

// The store is a module singleton whose in-memory slice survives across
// tests; reset it (and the backing storage, cleared by installMemoryStorage)
// before each case so pin state starts empty.
beforeEach(() => {
  usePinnedAppsStore.setState({ pinnedApps: [], pinnedAppIds: new Set() });
});

function makeApp(overrides: Partial<PinnableApp> & { id: string }): PinnableApp {
  return {
    name: `App ${overrides.id}`,
    ...overrides,
  };
}

function pin(app: PinnableApp): void {
  usePinnedAppsStore.getState().togglePin(app);
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
    usePinnedAppsStore.getState().togglePin(makeApp({ id: "a1", name: "First" }));

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

    expect(usePinnedAppsStore.getState().pinnedApps.map((a) => a.pinnedOrder)).toEqual([1, 2]);
    expect(usePinnedAppsStore.getState().pinnedApps.map((a) => a.appId)).toEqual(["a1", "a3"]);
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
    expect(usePinnedAppsStore.getState().pinnedApps.map((a) => a.appId)).toEqual(["a1"]);
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

describe("isPinned", () => {
  test("tracks pin/unpin transitions", () => {
    expect(usePinnedAppsStore.getState().isPinned("a1")).toBe(false);
    pin(makeApp({ id: "a1" }));
    expect(usePinnedAppsStore.getState().isPinned("a1")).toBe(true);
    usePinnedAppsStore.getState().unpin("a1");
    expect(usePinnedAppsStore.getState().isPinned("a1")).toBe(false);
  });
});
