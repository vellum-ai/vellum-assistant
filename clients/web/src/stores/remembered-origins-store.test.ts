import { describe, it, expect, beforeEach } from "bun:test";

/**
 * Holds a callback the provider hands back from inside its own `watch` call.
 *
 * A `let` initialized to `null` narrows to `null` for the rest of the scope,
 * since the compiler cannot prove the provider ever runs the assignment. A
 * property read carries the full union, so calling it stays type-checked.
 */
type WatchRef = { fn: (() => void) | null };

function watchRef(): WatchRef {
  return { fn: null };
}


import {
  REMEMBERED_ORIGINS_STORAGE_KEY,
  localStorageProvider,
  normalizeOriginUrl,
  setRememberedOriginsProvider,
  useRememberedOriginsStore,
  type RememberedOrigin,
  type RememberedOriginsProvider,
} from "@/stores/remembered-origins-store";

const store = () => useRememberedOriginsStore.getState();

beforeEach(async () => {
  window.localStorage.clear();
  setRememberedOriginsProvider(localStorageProvider);
  await store().hydrate();
});

describe("normalizeOriginUrl", () => {
  it("accepts a plain https origin", () => {
    expect(normalizeOriginUrl("https://example.com")).toBe(
      "https://example.com",
    );
  });

  it("rejects http", () => {
    expect(normalizeOriginUrl("http://example.com")).toBeNull();
  });

  it("rejects non-https schemes and garbage", () => {
    expect(normalizeOriginUrl("ftp://example.com")).toBeNull();
    expect(normalizeOriginUrl("not a url")).toBeNull();
    expect(normalizeOriginUrl("example.com")).toBeNull();
    expect(normalizeOriginUrl("")).toBeNull();
    expect(normalizeOriginUrl("   ")).toBeNull();
    expect(normalizeOriginUrl("https://")).toBeNull();
  });

  it("trims surrounding whitespace", () => {
    expect(normalizeOriginUrl("  https://example.com  ")).toBe(
      "https://example.com",
    );
  });

  it("strips trailing slashes", () => {
    expect(normalizeOriginUrl("https://example.com/")).toBe(
      "https://example.com",
    );
    expect(normalizeOriginUrl("https://example.com/assistant-123///")).toBe(
      "https://example.com/assistant-123",
    );
  });

  it("preserves the path prefix and port", () => {
    expect(normalizeOriginUrl("https://example.com/assistant-123")).toBe(
      "https://example.com/assistant-123",
    );
    expect(normalizeOriginUrl("https://example.com:8443/assistant-123")).toBe(
      "https://example.com:8443/assistant-123",
    );
  });

  it("drops query and hash", () => {
    expect(normalizeOriginUrl("https://example.com/a?register=1#frag")).toBe(
      "https://example.com/a",
    );
  });

  it("lowercases scheme and host but preserves path case", () => {
    expect(normalizeOriginUrl("HTTPS://Example.COM/Assistant-123")).toBe(
      "https://example.com/Assistant-123",
    );
  });

  it("strips userinfo credentials", () => {
    expect(normalizeOriginUrl("https://alice:secret@example.com/a")).toBe(
      "https://example.com/a",
    );
  });
});

describe("addOrigin", () => {
  it("adds a normalized entry with an ISO addedAt", async () => {
    const result = await store().addOrigin({
      url: "https://Example.com/assistant-123/",
      name: "Home box",
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.origin.url).toBe("https://example.com/assistant-123");
    expect(result.origin.name).toBe("Home box");
    expect(Number.isNaN(Date.parse(result.origin.addedAt))).toBe(false);
    expect(store().origins).toEqual([result.origin]);
  });

  it("returns { ok: false } for invalid urls and leaves state alone", async () => {
    expect(await store().addOrigin({ url: "http://example.com" })).toEqual({
      ok: false,
    });
    expect(await store().addOrigin({ url: "garbage" })).toEqual({ ok: false });
    expect(store().origins).toEqual([]);
  });

  it("dedupes by normalized url, keeping the original addedAt", async () => {
    const first = await store().addOrigin({ url: "https://example.com/a" });
    if (!first.ok) {
      throw new Error("expected ok");
    }
    const again = await store().addOrigin({
      url: "HTTPS://EXAMPLE.COM/a/?x=1",
    });
    if (!again.ok) {
      throw new Error("expected ok");
    }
    expect(store().origins).toHaveLength(1);
    expect(again.origin.addedAt).toBe(first.origin.addedAt);
  });

  it("re-adding updates the name only when a new one is provided", async () => {
    await store().addOrigin({ url: "https://example.com/a", name: "Old" });
    await store().addOrigin({ url: "https://example.com/a" });
    expect(store().origins[0]?.name).toBe("Old");

    await store().addOrigin({ url: "https://example.com/a", name: "New" });
    expect(store().origins[0]?.name).toBe("New");
    expect(store().origins).toHaveLength(1);
  });
});

describe("removeOrigin", () => {
  it("removes by normalized url", async () => {
    await store().addOrigin({ url: "https://example.com/a" });
    await store().addOrigin({ url: "https://example.com/b" });

    await store().removeOrigin("HTTPS://example.com/a/");
    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/b",
    ]);
  });

  it("is a no-op for unknown or invalid urls", async () => {
    await store().addOrigin({ url: "https://example.com/a" });
    await store().removeOrigin("https://example.com/other");
    await store().removeOrigin("not a url");
    expect(store().origins).toHaveLength(1);
  });
});

describe("localStorage persistence", () => {
  const rehydrate = async () => {
    setRememberedOriginsProvider(localStorageProvider);
    await store().hydrate();
  };

  it("round-trips entries through localStorage", async () => {
    await store().addOrigin({ url: "https://example.com/a", name: "A" });
    await store().addOrigin({ url: "https://example.com/b" });
    const before = store().origins;

    await rehydrate();
    expect(store().hydrated).toBe(true);
    expect(store().origins).toEqual(before);
  });

  it("persists only { name?, url, addedAt } fields", async () => {
    await store().addOrigin({ url: "https://example.com/a", name: "A" });
    const raw = window.localStorage.getItem(REMEMBERED_ORIGINS_STORAGE_KEY);
    const stored = JSON.parse(raw ?? "[]") as Record<string, unknown>[];
    expect(stored).toHaveLength(1);
    expect(Object.keys(stored[0] ?? {}).sort()).toEqual([
      "addedAt",
      "name",
      "url",
    ]);
  });

  it("recovers from corrupt JSON", async () => {
    window.localStorage.setItem(REMEMBERED_ORIGINS_STORAGE_KEY, "{not json");
    await rehydrate();
    expect(store().hydrated).toBe(true);
    expect(store().origins).toEqual([]);
  });

  it("drops non-array payloads and invalid entries", async () => {
    window.localStorage.setItem(
      REMEMBERED_ORIGINS_STORAGE_KEY,
      JSON.stringify({ url: "https://example.com" }),
    );
    await rehydrate();
    expect(store().origins).toEqual([]);

    window.localStorage.setItem(
      REMEMBERED_ORIGINS_STORAGE_KEY,
      JSON.stringify([
        { url: "https://example.com/good", addedAt: "2026-01-01T00:00:00Z" },
        { url: "http://example.com/insecure", addedAt: "x" },
        { name: "no url" },
        "not an object",
        null,
      ]),
    );
    await rehydrate();
    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/good",
    ]);
  });
});

describe("providers and hydration", () => {
  const makeFakeProvider = (initial: RememberedOrigin[]) => {
    let entries = initial;
    let loadCount = 0;
    const provider: RememberedOriginsProvider = {
      load: async () => {
        loadCount += 1;
        return entries;
      },
      save: async (next) => {
        entries = next;
      },
    };
    return {
      provider,
      getEntries: () => entries,
      getLoadCount: () => loadCount,
    };
  };

  it("setRememberedOriginsProvider re-hydrates from the new provider", async () => {
    await store().addOrigin({ url: "https://old.example.com" });

    const fake = makeFakeProvider([
      {
        url: "https://new.example.com/assistant-1",
        name: "Fake",
        addedAt: "2026-01-01T00:00:00Z",
      },
    ]);
    setRememberedOriginsProvider(fake.provider);
    await store().hydrate();

    expect(store().origins.map((o) => o.url)).toEqual([
      "https://new.example.com/assistant-1",
    ]);
  });

  it("writes go through the active provider", async () => {
    const fake = makeFakeProvider([]);
    setRememberedOriginsProvider(fake.provider);
    await store().hydrate();

    await store().addOrigin({ url: "https://example.com/a" });
    expect(fake.getEntries().map((o) => o.url)).toEqual([
      "https://example.com/a",
    ]);
    expect(window.localStorage.getItem(REMEMBERED_ORIGINS_STORAGE_KEY)).toBe(
      null,
    );

    await store().removeOrigin("https://example.com/a");
    expect(fake.getEntries()).toEqual([]);
  });

  it("concurrent hydrate calls share one provider load", async () => {
    const fake = makeFakeProvider([]);
    setRememberedOriginsProvider(fake.provider);

    await Promise.all([store().hydrate(), store().hydrate()]);
    await store().hydrate();
    expect(fake.getLoadCount()).toBe(1);
    expect(store().hydrated).toBe(true);
  });

  it("a failed load leaves the store unhydrated and a later hydrate retries", async () => {
    let failLoads = true;
    const provider: RememberedOriginsProvider = {
      load: async () => {
        if (failLoads) {
          throw new Error("provider unavailable");
        }
        return [
          { url: "https://example.com/real", addedAt: "2026-01-01T00:00:00Z" },
        ];
      },
      save: async () => {},
    };
    setRememberedOriginsProvider(provider);

    await store().hydrate();
    expect(store().hydrated).toBe(false);

    failLoads = false;
    await store().hydrate();
    expect(store().hydrated).toBe(true);
    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/real",
    ]);
  });

  it("a synchronous load() throw still allows a later hydrate to retry", async () => {
    let failLoads = true;
    const provider: RememberedOriginsProvider = {
      load: () => {
        if (failLoads) {
          throw new Error("synchronous failure");
        }
        return Promise.resolve([
          {
            url: "https://example.com/recovered",
            addedAt: "2026-01-01T00:00:00Z",
          },
        ]);
      },
      save: async () => {},
    };
    setRememberedOriginsProvider(provider);

    await store().hydrate();
    expect(store().hydrated).toBe(false);

    failLoads = false;
    await store().hydrate();
    expect(store().hydrated).toBe(true);
    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/recovered",
    ]);
  });

  it("a mutation after a failed hydration does not overwrite provider data", async () => {
    let saved: RememberedOrigin[] | null = null;
    const provider: RememberedOriginsProvider = {
      load: async () => {
        throw new Error("provider unavailable");
      },
      save: async (next) => {
        saved = next;
      },
    };
    setRememberedOriginsProvider(provider);

    const result = await store().addOrigin({ url: "https://example.com/b" });
    expect(result).toEqual({ ok: false });
    await store().removeOrigin("https://example.com/b");
    expect(saved).toBeNull();
    expect(store().hydrated).toBe(false);
  });

  it("merges the provider's latest value before saving a mutation", async () => {
    const fake = makeFakeProvider([]);
    setRememberedOriginsProvider(fake.provider);
    await store().hydrate();

    // Another tab persists A after this tab hydrated.
    await fake.provider.save([
      { url: "https://example.com/a", addedAt: "2026-01-01T00:00:00Z" },
    ]);

    await store().addOrigin({ url: "https://example.com/b" });
    expect(fake.getEntries().map((o) => o.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);

    // Same for removals: the other tab's entry survives.
    await fake.provider.save([
      { url: "https://example.com/a", addedAt: "2026-01-01T00:00:00Z" },
      { url: "https://example.com/b", addedAt: "2026-01-02T00:00:00Z" },
      { url: "https://example.com/c", addedAt: "2026-01-03T00:00:00Z" },
    ]);
    await store().removeOrigin("https://example.com/b");
    expect(fake.getEntries().map((o) => o.url)).toEqual([
      "https://example.com/a",
      "https://example.com/c",
    ]);
  });

  it("serializes async saves so a later mutation's save always lands last", async () => {
    let entries: RememberedOrigin[] = [];
    const saveLog: string[][] = [];
    let pendingSaves = 0;
    const provider: RememberedOriginsProvider = {
      load: async () => entries,
      save: async (next) => {
        // First save is slow; without serialization it would finish after
        // the second save and roll persisted state back to just [a].
        pendingSaves += 1;
        const delayMs = pendingSaves === 1 ? 20 : 0;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        entries = next;
        saveLog.push(next.map((o) => o.url));
      },
    };
    setRememberedOriginsProvider(provider);
    await store().hydrate();

    await Promise.all([
      store().addOrigin({ url: "https://example.com/a" }),
      store().addOrigin({ url: "https://example.com/b" }),
    ]);

    expect(saveLog).toEqual([
      ["https://example.com/a"],
      ["https://example.com/a", "https://example.com/b"],
    ]);
    expect(entries.map((o) => o.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("aborts a mutation when the provider is swapped mid-mutation", async () => {
    let loads = 0;
    let releaseMutationLoad = () => {};
    const gate = new Promise<void>((resolve) => {
      releaseMutationLoad = resolve;
    });
    let oldProviderSaved = false;
    const oldProvider: RememberedOriginsProvider = {
      load: async () => {
        loads += 1;
        if (loads > 1) {
          await gate;
        }
        return [
          { url: "https://old.example.com/a", addedAt: "2026-01-01T00:00:00Z" },
        ];
      },
      save: async () => {
        oldProviderSaved = true;
      },
    };
    setRememberedOriginsProvider(oldProvider);
    await store().hydrate();

    const pending = store().addOrigin({ url: "https://example.com/new" });
    // Wait until the mutation is awaiting the old provider's load, then swap.
    while (loads < 2) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const fresh = makeFakeProvider([
      { url: "https://fresh.example.com/x", addedAt: "2026-01-01T00:00:00Z" },
    ]);
    setRememberedOriginsProvider(fresh.provider);
    releaseMutationLoad();

    expect(await pending).toEqual({ ok: false });
    expect(oldProviderSaved).toBe(false);
    expect(fresh.getEntries().map((o) => o.url)).toEqual([
      "https://fresh.example.com/x",
    ]);
  });

  it("does not publish state when the provider's save fails", async () => {
    const seeded = [
      { url: "https://example.com/kept", addedAt: "2026-01-01T00:00:00Z" },
    ];
    let failSaves = false;
    let entries = seeded;
    const provider: RememberedOriginsProvider = {
      load: async () => entries,
      save: async (next) => {
        if (failSaves) {
          throw new Error("save failed");
        }
        entries = next;
      },
    };
    setRememberedOriginsProvider(provider);
    await store().hydrate();

    failSaves = true;
    const result = await store().addOrigin({ url: "https://example.com/new" });
    expect(result).toEqual({ ok: false });
    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/kept",
    ]);
    expect(store().hydrated).toBe(true);

    await store().removeOrigin("https://example.com/kept");
    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/kept",
    ]);
    expect(entries).toEqual(seeded);
  });

  it("refreshes hydrated state when another tab changes localStorage", async () => {
    // beforeEach hydrated the default localStorage provider with an empty
    // list. Simulate another tab writing an entry, which the browser
    // announces via a storage event.
    window.localStorage.setItem(
      REMEMBERED_ORIGINS_STORAGE_KEY,
      JSON.stringify([
        { url: "https://other-tab.example.com", addedAt: "2026-01-01T00:00:00Z" },
      ]),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: REMEMBERED_ORIGINS_STORAGE_KEY }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(store().origins.map((o) => o.url)).toEqual([
      "https://other-tab.example.com",
    ]);
  });

  it("a watch event after a failed hydration retries hydration", async () => {
    let failLoads = true;
    const watch = watchRef();
    const provider: RememberedOriginsProvider = {
      load: async () => {
        if (failLoads) {
          throw new Error("provider unavailable");
        }
        return [
          {
            url: "https://example.com/recovered",
            addedAt: "2026-01-01T00:00:00Z",
          },
        ];
      },
      save: async () => {},
      watch: (onChange) => {
        watch.fn = onChange;
        return () => {};
      },
    };
    setRememberedOriginsProvider(provider);
    await store().hydrate();
    expect(store().hydrated).toBe(false);

    // The provider recovers and announces a change; no caller invokes
    // hydrate() manually.
    failLoads = false;
    watch.fn?.();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store().hydrated).toBe(true);
    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/recovered",
    ]);
  });

  it("re-refreshes after hydration when a watch event fired mid-hydration", async () => {
    let entries: RememberedOrigin[] = [
      { url: "https://example.com/new", addedAt: "2026-01-02T00:00:00Z" },
    ];
    const watch = watchRef();
    let releaseHydrateLoad = () => {};
    const hydrateGate = new Promise<void>((resolve) => {
      releaseHydrateLoad = resolve;
    });
    let loads = 0;
    const provider: RememberedOriginsProvider = {
      load: async () => {
        loads += 1;
        if (loads === 1) {
          // The initial hydration load is slow and returns a snapshot that
          // is already stale by the time it resolves.
          await hydrateGate;
          return [
            { url: "https://example.com/old", addedAt: "2026-01-01T00:00:00Z" },
          ];
        }
        return entries;
      },
      save: async (next) => {
        entries = next;
      },
      watch: (onChange) => {
        watch.fn = onChange;
        return () => {};
      },
    };
    setRememberedOriginsProvider(provider);

    // The provider's value changes while hydration is still loading.
    watch.fn?.();
    await new Promise((resolve) => setTimeout(resolve, 1));
    releaseHydrateLoad();
    await store().hydrate();
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/new",
    ]);
  });

  it("serializes watch refreshes with mutations so a slow refresh cannot publish stale state", async () => {
    let entries: RememberedOrigin[] = [
      { url: "https://example.com/a", addedAt: "2026-01-01T00:00:00Z" },
    ];
    const watch = watchRef();
    let gate: Promise<void> | null = null;
    let releaseGate = () => {};
    const provider: RememberedOriginsProvider = {
      load: async () => {
        if (gate) {
          const pending = gate;
          gate = null;
          await pending;
        }
        return entries;
      },
      save: async (next) => {
        entries = next;
      },
      watch: (onChange) => {
        watch.fn = onChange;
        return () => {};
      },
    };
    setRememberedOriginsProvider(provider);
    await store().hydrate();

    // A watch-triggered refresh starts a slow load, then a mutation runs.
    gate = new Promise((resolve) => {
      releaseGate = resolve;
    });
    watch.fn?.();
    const add = store().addOrigin({ url: "https://example.com/b" });
    releaseGate();
    await add;
    await new Promise((resolve) => setTimeout(resolve, 5));

    expect(store().origins.map((o) => o.url)).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("runs mutations inside a Web Lock when navigator.locks exists", async () => {
    const requested: string[] = [];
    const fakeLocks = {
      request: (name: string, callback: () => Promise<unknown>) => {
        requested.push(name);
        return callback();
      },
    } as unknown as LockManager;
    const original = Object.getOwnPropertyDescriptor(navigator, "locks");
    Object.defineProperty(navigator, "locks", {
      value: fakeLocks,
      configurable: true,
    });
    try {
      await store().addOrigin({ url: "https://example.com/locked" });
      await store().removeOrigin("https://example.com/locked");
    } finally {
      if (original) {
        Object.defineProperty(navigator, "locks", original);
      } else {
        delete (navigator as { locks?: unknown }).locks;
      }
    }
    // The two mutations acquire the lock; watch-triggered refreshes from
    // our own saves may acquire it additional times.
    expect(requested.length).toBeGreaterThanOrEqual(2);
    expect(new Set(requested)).toEqual(
      new Set(["vellum:remembered-origins:mutate"]),
    );
  });
});
