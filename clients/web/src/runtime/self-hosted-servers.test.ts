/**
 * The `SelfHostedServers` bridge seam: the store provider's mapping and
 * diff-save, the switch and baked-origin reads, and the skew fallbacks that
 * keep an older shell (no plugin) on the localStorage behavior it already had.
 *
 * Self-contained mocks: run this file solo (`mock.module` leaks across a
 * shared `bun test` run).
 */

import {
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

let isNativeMobileValue = true;
mock.module("@/runtime/platform-detection", () => ({
  isNativeMobile: () => isNativeMobileValue,
}));

interface NativeEntry {
  name?: string;
  url: string;
}
interface NativeList {
  servers: NativeEntry[];
  activeUrl: string | null;
  bakedUrl: string | null;
}

let listResult: NativeList = { servers: [], activeUrl: null, bakedUrl: null };
/** Simulates a shell whose build predates the plugin: every call rejects. */
let bridgeRejects = false;
let addRejects = false;
/** Rejects `add` for one url only, so a partial write can be exercised. */
let addRejectsUrl: string | null = null;

function bridgeFailure(method: string): Error {
  return new Error(`SelfHostedServers.${method}() is not implemented on ios`);
}

/**
 * What the shell was asked to do, in order. The widget snapshot has to be
 * dropped BEFORE the shell leaves for another origin: after the swap the page
 * is gone, and the localStorage producer id that catches a stale snapshot
 * anywhere else is per-origin and does not travel with it.
 */
const bridgeOrder: string[] = [];

const clearWidgetSnapshotMock = mock(async () => {
  bridgeOrder.push("clearWidgetSnapshot");
  return true;
});
mock.module("@/runtime/widget-snapshot", () => ({
  clearWidgetSnapshot: clearWidgetSnapshotMock,
}));

const listMock = mock(async (): Promise<NativeList> => {
  if (bridgeRejects) {
    throw bridgeFailure("list");
  }
  return listResult;
});
const addMock = mock(async (options: { url: string; name?: string }) => {
  if (bridgeRejects || addRejects || options.url === addRejectsUrl) {
    throw bridgeFailure("add");
  }
  return { ok: true };
});
const removeMock = mock(async (_options: { url: string }) => {
  if (bridgeRejects) {
    throw bridgeFailure("remove");
  }
  return { ok: true };
});
const switchToMock = mock(async (_options: { url?: string }) => {
  bridgeOrder.push("switchTo");
  if (bridgeRejects) {
    throw bridgeFailure("switchTo");
  }
  return { ok: true };
});
const switchToPathMock = mock(
  async (_options: { url?: string; path: string }) => {
    bridgeOrder.push("switchToPath");
    if (bridgeRejects) {
      throw bridgeFailure("switchToPath");
    }
    return { ok: true };
  },
);

mock.module("@capacitor/core", () => ({
  registerPlugin: (name: string) =>
    name === "SelfHostedServers"
      ? {
          list: listMock,
          add: addMock,
          remove: removeMock,
          switchTo: switchToMock,
          switchToPath: switchToPathMock,
        }
      : {},
}));

const {
  installNativeRememberedOrigins,
  nativeRememberedOriginsProvider,
  nativeSwitchToOrigin,
  nativeSwitchToOriginPath,
  nativeVellumCloudOrigin,
} = await import("@/runtime/self-hosted-servers");

const {
  REMEMBERED_ORIGINS_STORAGE_KEY,
  localStorageProvider,
  setRememberedOriginsProvider,
  useRememberedOriginsStore,
} = await import("@/stores/remembered-origins-store");

const consoleDebugSpy = spyOn(console, "debug").mockImplementation(() => {});

const EPOCH = "1970-01-01T00:00:00.000Z";

beforeEach(() => {
  isNativeMobileValue = true;
  listResult = { servers: [], activeUrl: null, bakedUrl: null };
  bridgeRejects = false;
  addRejects = false;
  addRejectsUrl = null;
  listMock.mockClear();
  addMock.mockClear();
  removeMock.mockClear();
  switchToMock.mockClear();
  switchToPathMock.mockClear();
  clearWidgetSnapshotMock.mockClear();
  bridgeOrder.length = 0;
  consoleDebugSpy.mockClear();
  window.localStorage.clear();
});

describe("nativeRememberedOriginsProvider load", () => {
  test("maps the native list onto store entries in canonical form", async () => {
    listResult = {
      servers: [
        { name: "Homelab", url: "https://host.example/assistant-1" },
        { url: "HTTPS://Other.Example/" },
      ],
      activeUrl: "https://host.example/assistant-1",
      bakedUrl: "https://app.vellum.ai",
    };

    expect(await nativeRememberedOriginsProvider().load()).toEqual([
      {
        name: "Homelab",
        url: "https://host.example/assistant-1",
        addedAt: EPOCH,
      },
      { url: "https://other.example", addedAt: EPOCH },
    ]);
  });

  test("drops unusable and duplicate native entries", async () => {
    listResult = {
      servers: [
        { url: "https://host.example" },
        { url: "https://host.example/" },
        { url: "http://insecure.example" },
        { url: "not a url" },
      ],
      activeUrl: null,
      bakedUrl: null,
    };

    expect(
      (await nativeRememberedOriginsProvider().load()).map((o) => o.url),
    ).toEqual(["https://host.example"]);
  });

  test("falls back to the localStorage provider on an older shell", async () => {
    bridgeRejects = true;
    await localStorageProvider.save([
      { url: "https://stored.example", name: "Stored", addedAt: EPOCH },
    ]);

    expect(await nativeRememberedOriginsProvider().load()).toEqual([
      { url: "https://stored.example", name: "Stored", addedAt: EPOCH },
    ]);
    // An older shell is an expected state on every web deploy, so it is a
    // debug line rather than a captured error.
    expect(consoleDebugSpy).toHaveBeenCalled();
  });

  test("migrates pre-plugin localStorage entries into the native list once", async () => {
    await localStorageProvider.save([
      { url: "https://legacy.example", name: "Legacy", addedAt: EPOCH },
      { url: "https://shared.example", addedAt: EPOCH },
    ]);
    listResult = {
      servers: [{ url: "https://shared.example" }],
      activeUrl: null,
      bakedUrl: null,
    };

    const provider = nativeRememberedOriginsProvider();
    const first = await provider.load();

    // The entry the native list already holds is not re-added.
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith({
      url: "https://legacy.example",
      name: "Legacy",
    });
    expect(first.map((o) => o.url)).toEqual([
      "https://shared.example",
      "https://legacy.example",
    ]);

    // Migration is one-time: a later load issues no further writes.
    addMock.mockClear();
    listResult = {
      servers: [
        { url: "https://shared.example" },
        { name: "Legacy", url: "https://legacy.example" },
      ],
      activeUrl: null,
      bakedUrl: null,
    };
    await provider.load();
    expect(addMock).not.toHaveBeenCalled();
  });

  test("retries the migration when a native add fails", async () => {
    await localStorageProvider.save([
      { url: "https://legacy.example", addedAt: EPOCH },
    ]);
    addRejects = true;

    const provider = nativeRememberedOriginsProvider();
    // The shell does not hold the entry, so no card is published for it.
    expect((await provider.load()).map((o) => o.url)).toEqual([]);

    addRejects = false;
    addMock.mockClear();
    expect((await provider.load()).map((o) => o.url)).toEqual([
      "https://legacy.example",
    ]);
    expect(addMock).toHaveBeenCalledWith({ url: "https://legacy.example" });
  });

  test("a partial migration publishes only the entries the shell accepted", async () => {
    await localStorageProvider.save([
      { url: "https://first.example", addedAt: EPOCH },
      { url: "https://second.example", addedAt: EPOCH },
    ]);
    addRejectsUrl = "https://second.example";

    expect(
      (await nativeRememberedOriginsProvider().load()).map((o) => o.url),
    ).toEqual(["https://first.example"]);
  });
});

describe("nativeRememberedOriginsProvider save", () => {
  test("issues only the add and remove deltas", async () => {
    listResult = {
      servers: [
        { url: "https://keep.example", name: "Keep" },
        { url: "https://drop.example" },
      ],
      activeUrl: null,
      bakedUrl: null,
    };

    await nativeRememberedOriginsProvider().save([
      { url: "https://keep.example", name: "Keep", addedAt: EPOCH },
      { url: "https://new.example", name: "New", addedAt: EPOCH },
    ]);

    expect(removeMock).toHaveBeenCalledTimes(1);
    expect(removeMock).toHaveBeenCalledWith({ url: "https://drop.example" });
    expect(addMock).toHaveBeenCalledTimes(1);
    expect(addMock).toHaveBeenCalledWith({
      url: "https://new.example",
      name: "New",
    });
  });

  test("writes nothing when the desired list already matches", async () => {
    listResult = {
      servers: [{ url: "https://keep.example", name: "Keep" }],
      activeUrl: null,
      bakedUrl: null,
    };

    await nativeRememberedOriginsProvider().save([
      { url: "https://keep.example", name: "Keep", addedAt: EPOCH },
    ]);

    expect(addMock).not.toHaveBeenCalled();
    expect(removeMock).not.toHaveBeenCalled();
  });

  test("re-adds an entry whose label changed", async () => {
    listResult = {
      servers: [{ url: "https://keep.example", name: "Old" }],
      activeUrl: null,
      bakedUrl: null,
    };

    await nativeRememberedOriginsProvider().save([
      { url: "https://keep.example", name: "New", addedAt: EPOCH },
    ]);

    expect(addMock).toHaveBeenCalledWith({
      url: "https://keep.example",
      name: "New",
    });
    expect(removeMock).not.toHaveBeenCalled();
  });

  test("surfaces a rejected write instead of dropping the entry", async () => {
    addRejects = true;

    await expect(
      nativeRememberedOriginsProvider().save([
        { url: "https://new.example", addedAt: EPOCH },
      ]),
    ).rejects.toThrow();
  });

  test("falls back to the localStorage provider on an older shell", async () => {
    bridgeRejects = true;

    await nativeRememberedOriginsProvider().save([
      { url: "https://stored.example", addedAt: EPOCH },
    ]);

    expect(addMock).not.toHaveBeenCalled();
    const raw = window.localStorage.getItem(REMEMBERED_ORIGINS_STORAGE_KEY);
    expect(raw).toContain("https://stored.example");
  });
});

describe("nativeSwitchToOrigin", () => {
  test("swaps the shell origin and reports success", async () => {
    expect(await nativeSwitchToOrigin("https://host.example")).toBe(true);
    expect(switchToMock).toHaveBeenCalledWith({
      url: "https://host.example",
    });
  });

  test("a null url asks for the baked origin", async () => {
    expect(await nativeSwitchToOrigin(null)).toBe(true);
    expect(switchToMock).toHaveBeenCalledWith({});
  });

  test("switches to a relative path atomically", async () => {
    expect(
      await nativeSwitchToOriginPath(null, "select-assistant?noAutoSkip=1"),
    ).toBe(true);
    expect(switchToPathMock).toHaveBeenCalledWith({
      path: "select-assistant?noAutoSkip=1",
    });
  });

  test("path switching resolves false on an older shell", async () => {
    bridgeRejects = true;

    expect(
      await nativeSwitchToOriginPath(null, "select-assistant?noAutoSkip=1"),
    ).toBe(false);
    expect(consoleDebugSpy).toHaveBeenCalled();
  });

  test("resolves false on an older shell so the caller can fall back", async () => {
    bridgeRejects = true;

    expect(await nativeSwitchToOrigin("https://host.example")).toBe(false);
    expect(consoleDebugSpy).toHaveBeenCalled();
  });

  test("never reaches the bridge off native mobile", async () => {
    isNativeMobileValue = false;

    expect(await nativeSwitchToOrigin("https://host.example")).toBe(false);
    expect(switchToMock).not.toHaveBeenCalled();
    expect(clearWidgetSnapshotMock).not.toHaveBeenCalled();
  });

  test("drops the widget snapshot before the shell leaves the origin", async () => {
    // The target is a different deployment with its own conversations, and
    // once the swap lands there is no page left to clean up from. The clear
    // lives here rather than at the call sites so that no way of leaving an
    // origin can forget it.
    await nativeSwitchToOrigin("https://host.example");

    expect(bridgeOrder).toEqual(["clearWidgetSnapshot", "switchTo"]);
  });

  test("drops the widget snapshot before a path switch too", async () => {
    await nativeSwitchToOriginPath(null, "select-assistant?noAutoSkip=1");

    expect(bridgeOrder).toEqual(["clearWidgetSnapshot", "switchToPath"]);
  });

  test("returning to the baked origin drops the snapshot as well", async () => {
    // The way back to Vellum Cloud is an origin swap like any other, and it
    // is the one the assistant chooser and the pair page take.
    await nativeSwitchToOrigin(null);

    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("drops the snapshot even when the shell is too old to switch", async () => {
    // A rejected switch leaves the caller to navigate out of the origin
    // instead, which loses the page just the same.
    bridgeRejects = true;

    expect(await nativeSwitchToOrigin("https://host.example")).toBe(false);
    expect(clearWidgetSnapshotMock).toHaveBeenCalledTimes(1);
  });

  test("swaps anyway when the snapshot clear does not land", async () => {
    // A shell too old to carry the snapshot plugin, or one that never answers
    // the call, must not be able to strand the user on this origin. The drop
    // is not lost with the attempt: the module persists the obligation and
    // finishes it on the next use, which is why nothing here reads the result.
    clearWidgetSnapshotMock.mockImplementationOnce(async () => {
      bridgeOrder.push("clearWidgetSnapshot");
      return false;
    });

    expect(await nativeSwitchToOrigin("https://host.example")).toBe(true);
    expect(bridgeOrder).toEqual(["clearWidgetSnapshot", "switchTo"]);
  });
});

describe("nativeVellumCloudOrigin", () => {
  test("reports the baked origin while a self-hosted origin is active", async () => {
    listResult = {
      servers: [],
      activeUrl: "https://host.example",
      bakedUrl: "https://app.vellum.ai/",
    };

    expect(await nativeVellumCloudOrigin()).toBe("https://app.vellum.ai");
  });

  test("reports nothing when the shell already serves the baked origin", async () => {
    listResult = {
      servers: [],
      activeUrl: null,
      bakedUrl: "https://app.vellum.ai",
    };

    expect(await nativeVellumCloudOrigin()).toBeNull();
  });

  test("reports nothing when the baked origin is unreadable", async () => {
    listResult = {
      servers: [],
      activeUrl: "https://host.example",
      bakedUrl: null,
    };

    expect(await nativeVellumCloudOrigin()).toBeNull();
  });

  test("reports nothing on an older shell or off native mobile", async () => {
    bridgeRejects = true;
    expect(await nativeVellumCloudOrigin()).toBeNull();

    bridgeRejects = false;
    isNativeMobileValue = false;
    listResult = {
      servers: [],
      activeUrl: "https://host.example",
      bakedUrl: "https://app.vellum.ai",
    };
    expect(await nativeVellumCloudOrigin()).toBeNull();
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

// Installing swaps the process-wide store provider, so this runs last.
describe("installNativeRememberedOrigins", () => {
  test("leaves the localStorage provider in place off native mobile", async () => {
    isNativeMobileValue = false;
    await localStorageProvider.save([
      { url: "https://stored.example", addedAt: EPOCH },
    ]);

    installNativeRememberedOrigins();
    await useRememberedOriginsStore.getState().hydrate();

    expect(
      useRememberedOriginsStore.getState().origins.map((o) => o.url),
    ).toEqual(["https://stored.example"]);
    expect(listMock).not.toHaveBeenCalled();
  });

  test("points the store at the native list on a mobile shell", async () => {
    listResult = {
      servers: [{ url: "https://host.example", name: "Homelab" }],
      activeUrl: "https://host.example",
      bakedUrl: "https://app.vellum.ai",
    };

    installNativeRememberedOrigins();
    await useRememberedOriginsStore.getState().hydrate();

    expect(useRememberedOriginsStore.getState().origins).toEqual([
      { url: "https://host.example", name: "Homelab", addedAt: EPOCH },
    ]);

    setRememberedOriginsProvider(localStorageProvider);
  });
});
