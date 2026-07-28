import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { runInPluginContext } from "../../../plugins/plugin-execution-context.js";

// ---------------------------------------------------------------------------
// Verifies the facade's plugin-scoping guard: the plugin-index operations must
// run inside a plugin execution context, and they pass the *context's* plugin
// name (never a caller argument) down to the host layer. This file runs in its
// own Bun process, so these mocks cannot leak elsewhere.
// ---------------------------------------------------------------------------

const received = { plugin: null as string | null };

mock.module("../plugin-index.js", () => ({
  computePluginEmbedding: async () => ({
    vector: [0],
    provider: "p",
    model: "m",
    dimensions: 1,
  }),
  computePluginSparseEmbedding: () => ({ indices: [], values: [] }),
  indexPluginDocument: async (_cfg: unknown, plugin: string) => {
    received.plugin = plugin;
    return { documentId: "d", provider: "p", model: "m", dimensions: 1 };
  },
  queryPluginIndex: async (_cfg: unknown, plugin: string) => {
    received.plugin = plugin;
    return [];
  },
  getPluginDocument: async (plugin: string) => {
    received.plugin = plugin;
    return null;
  },
  removePluginDocument: async (plugin: string) => {
    received.plugin = plugin;
  },
  purgePluginEmbeddings: async (plugin: string) => {
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

describe("plugin-index facade guard", () => {
  test("index/query/get/remove reject outside any plugin context", async () => {
    await expect(facade.indexPluginDocument("x")).rejects.toThrow(
      /active plugin execution context/,
    );
    await expect(facade.queryPluginIndex("x")).rejects.toThrow(
      /active plugin execution context/,
    );
    await expect(facade.getPluginDocument("d")).rejects.toThrow(
      /active plugin execution context/,
    );
    await expect(facade.removePluginDocument("d")).rejects.toThrow(
      /active plugin execution context/,
    );
  });

  test("purgePluginEmbeddings requires context unless a name is passed", async () => {
    await expect(facade.purgePluginEmbeddings()).rejects.toThrow(
      /active plugin execution context/,
    );
    // Host-initiated purge (uninstall) may name the plugin explicitly.
    await facade.purgePluginEmbeddings("being-uninstalled");
    expect(received.plugin).toBe("being-uninstalled");
  });

  test("the context's plugin name is what reaches the host layer", async () => {
    await runInPluginContext("alice", () => facade.getPluginDocument("d"));
    expect(received.plugin).toBe("alice");

    await runInPluginContext("bob", () => facade.indexPluginDocument("note"));
    expect(received.plugin).toBe("bob");
  });
});
