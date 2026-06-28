import { describe, expect, test } from "bun:test";

import { MemoryConfigSchema } from "../../config/schemas/memory.js";
import { MemoryProviderRegistry, NullMemoryProvider } from "./registry.js";
import type { MemoryProvider, MemoryProviderId } from "./types.js";

function stubProvider(id: MemoryProviderId): MemoryProvider {
  return {
    id,
    async retrieveForContext() {
      return [];
    },
    async retrieveForTurn() {
      return [];
    },
    async onTurnCommit() {},
    provideTools() {
      return [];
    },
    async init() {},
    async shutdown() {},
  };
}

describe("NullMemoryProvider", () => {
  test("is behavior-neutral: empty retrieval, no tools, resolving lifecycle", async () => {
    const provider = new NullMemoryProvider();
    expect(provider.id).toBe("none");
    expect(await provider.retrieveForContext()).toEqual([]);
    expect(await provider.retrieveForTurn()).toEqual([]);
    expect(provider.provideTools()).toEqual([]);
    expect(provider.provideRoutes()).toEqual([]);
    await expect(provider.onTurnCommit()).resolves.toBeUndefined();
    await expect(provider.init()).resolves.toBeUndefined();
    await expect(provider.shutdown()).resolves.toBeUndefined();
  });
});

describe("MemoryProviderRegistry", () => {
  test("resolves a registered provider for a pinned config", () => {
    const registry = new MemoryProviderRegistry();
    const v2 = stubProvider("v2");
    registry.register("v2", () => v2);

    const config = MemoryConfigSchema.parse({ provider: "v2" });
    expect(registry.resolve(config)).toBe(v2);
  });

  test("invokes the factory on each resolve", () => {
    const registry = new MemoryProviderRegistry();
    let calls = 0;
    registry.register("v3", () => {
      calls += 1;
      return stubProvider("v3");
    });

    const config = MemoryConfigSchema.parse({ provider: "v3" });
    registry.resolve(config);
    registry.resolve(config);
    expect(calls).toBe(2);
  });

  test("throws on duplicate registration for the same id", () => {
    const registry = new MemoryProviderRegistry();
    registry.register("graph", () => stubProvider("graph"));
    expect(() =>
      registry.register("graph", () => stubProvider("graph")),
    ).toThrow(/already registered/);
  });

  test("falls back to a null provider when the resolved id is unregistered", () => {
    const registry = new MemoryProviderRegistry();
    const config = MemoryConfigSchema.parse({ provider: "v2" });
    const resolved = registry.resolve(config);
    expect(resolved).toBeInstanceOf(NullMemoryProvider);
  });

  test('falls back to a null provider for the "auto" default', () => {
    const registry = new MemoryProviderRegistry();
    registry.register("v2", () => stubProvider("v2"));

    const config = MemoryConfigSchema.parse({});
    expect(config.provider).toBe("auto");
    expect(registry.resolve(config)).toBeInstanceOf(NullMemoryProvider);
  });
});

describe("MemoryConfigSchema provider field", () => {
  test('defaults provider to "auto" when omitted', () => {
    expect(MemoryConfigSchema.parse({}).provider).toBe("auto");
  });

  test("accepts an explicit provider value", () => {
    expect(MemoryConfigSchema.parse({ provider: "none" }).provider).toBe(
      "none",
    );
  });

  test("rejects an unknown provider value", () => {
    expect(() => MemoryConfigSchema.parse({ provider: "bogus" })).toThrow();
  });
});
