import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { runInPluginContext } from "../../../plugins/plugin-execution-context.js";

// ---------------------------------------------------------------------------
// Verifies the facade's plugin-scoping guard: the index operations must run
// inside a plugin execution context, and they pass the context's plugin name
// (never a caller argument) down to the host layer. This file runs in its own
// Bun process, so these mocks cannot leak elsewhere.
// ---------------------------------------------------------------------------

const received = { plugin: null as string | null };

mock.module("../plugin-index.js", () => ({
  computeEmbedding: async () => ({
    vector: [0],
    provider: "p",
    model: "m",
    dimensions: 1,
  }),
  computeSparseEmbedding: () => ({ indices: [], values: [] }),
  indexDocument: async (_cfg: unknown, plugin: string) => {
    received.plugin = plugin;
    return { documentId: "d", provider: "p", model: "m", dimensions: 1 };
  },
  queryIndex: async (_cfg: unknown, plugin: string) => {
    received.plugin = plugin;
    return [];
  },
  getDocument: async (plugin: string) => {
    received.plugin = plugin;
    return null;
  },
  removeDocument: async (plugin: string) => {
    received.plugin = plugin;
  },
}));
mock.module("../../../config/loader.js", () => ({ getConfig: () => ({}) }));

const facade = await import("../plugin-facade.js");

beforeEach(() => {
  received.plugin = null;
});

afterAll(() => {
  mock.restore();
});

describe("plugin index facade guard", () => {
  test("index/query/get/remove reject outside any plugin context", async () => {
    await expect(facade.indexDocument("x")).rejects.toThrow(
      /active plugin execution context/,
    );
    await expect(facade.queryIndex("x")).rejects.toThrow(
      /active plugin execution context/,
    );
    await expect(facade.getDocument("d")).rejects.toThrow(
      /active plugin execution context/,
    );
    await expect(facade.removeDocument("d")).rejects.toThrow(
      /active plugin execution context/,
    );
  });

  test("the context's plugin name is what reaches the host layer", async () => {
    await runInPluginContext("alice", () => facade.getDocument("d"));
    expect(received.plugin).toBe("alice");

    await runInPluginContext("bob", () => facade.indexDocument("note"));
    expect(received.plugin).toBe("bob");
  });
});
