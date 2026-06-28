/**
 * `resolveMemoryProvider` / `resolveMemoryProviderId` tests.
 *
 * The id resolution is the load-bearing replacement for the former
 * `isMemoryV3Live()` gate: under `memory.provider: "auto"` (the default and the
 * value every existing install resolves through), the id matches the legacy
 * `v3.live` → v3, else `v2.enabled` → v2, else graph selection exactly. An
 * explicit `memory.provider` pins a specific system end-to-end. The provider
 * modules are stubbed so the test exercises the registry wiring without pulling
 * in the heavy graph/v2/v3 runtimes.
 */

import { describe, expect, mock, test } from "bun:test";

import { AssistantConfigSchema } from "../../config/schema.js";
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

mock.module("./graph-provider.js", () => ({
  GraphMemoryProvider: stubProvider("graph"),
}));
mock.module("./v2-provider.js", () => ({
  V2MemoryProvider: stubProvider("v2"),
}));
mock.module("./v3-provider.js", () => ({
  V3MemoryProvider: stubProvider("v3"),
}));

const { resolveMemoryProvider, resolveMemoryProviderId } =
  await import("./resolve.js");

/** A full default {@link AssistantConfig} with `memory` overrides applied. */
function configWith(memory: Record<string, unknown>) {
  return AssistantConfigSchema.parse({ memory });
}

describe("resolveMemoryProviderId", () => {
  test('default config ("auto", v2.enabled, !v3.live) resolves to v2', () => {
    const config = AssistantConfigSchema.parse({});
    expect(config.memory.provider).toBe("auto");
    expect(config.memory.v2.enabled).toBe(true);
    expect(config.memory.v3.live).toBe(false);
    expect(resolveMemoryProviderId(config)).toBe("v2");
  });

  test('"auto" with v3.live resolves to v3 (legacy isMemoryV3Live parity)', () => {
    const config = configWith({ provider: "auto", v3: { live: true } });
    expect(resolveMemoryProviderId(config)).toBe("v3");
  });

  test('"auto" with v3.live wins even when v2 is enabled', () => {
    const config = configWith({
      provider: "auto",
      v2: { enabled: true },
      v3: { live: true },
    });
    expect(resolveMemoryProviderId(config)).toBe("v3");
  });

  test('"auto" with v2 disabled and v3 off falls back to graph', () => {
    const config = configWith({
      provider: "auto",
      v2: { enabled: false },
      v3: { live: false },
    });
    expect(resolveMemoryProviderId(config)).toBe("graph");
  });

  test.each(["graph", "v2", "v3", "none"] as const)(
    'explicit provider "%s" pins that id regardless of v2/v3 flags',
    (provider) => {
      const config = configWith({
        provider,
        v2: { enabled: true },
        v3: { live: true },
      });
      expect(resolveMemoryProviderId(config)).toBe(provider);
    },
  );
});

describe("resolveMemoryProvider", () => {
  test("returns the provider whose id matches the resolved selection", () => {
    expect(resolveMemoryProvider(configWith({ provider: "graph" })).id).toBe(
      "graph",
    );
    expect(resolveMemoryProvider(configWith({ provider: "v2" })).id).toBe("v2");
    expect(resolveMemoryProvider(configWith({ provider: "v3" })).id).toBe("v3");
  });

  test('"auto" default resolves to the v2 provider', () => {
    expect(resolveMemoryProvider(AssistantConfigSchema.parse({})).id).toBe(
      "v2",
    );
  });

  test('"none" resolves to a behavior-neutral null provider', () => {
    const provider = resolveMemoryProvider(configWith({ provider: "none" }));
    expect(provider.id).toBe("none");
    expect(provider.provideTools()).toEqual([]);
  });

  test("switching memory.provider switches the active system end-to-end", () => {
    expect(resolveMemoryProvider(configWith({ provider: "v2" })).id).toBe("v2");
    expect(resolveMemoryProvider(configWith({ provider: "v3" })).id).toBe("v3");
    expect(resolveMemoryProvider(configWith({ provider: "graph" })).id).toBe(
      "graph",
    );
  });
});
