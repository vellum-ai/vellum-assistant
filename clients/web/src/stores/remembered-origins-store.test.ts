import { describe, it, expect, beforeEach } from "bun:test";

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
});
