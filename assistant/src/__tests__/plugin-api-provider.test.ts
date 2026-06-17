/**
 * `getConfiguredProvider` is part of the public `@vellumai/plugin-api` runtime
 * surface, so a user-installable plugin can run inference through the
 * workspace's configured profiles/credentials (managed-proxy or BYOK) without
 * supplying its own API key.
 */
import { describe, expect, test } from "bun:test";

import { PLUGIN_API_EXPORTS } from "../embedded/plugin-api.js";
import * as pluginApi from "../plugin-api/index.js";

describe("plugin-api provider access", () => {
  test("getConfiguredProvider is exported as a runtime value", () => {
    expect(typeof pluginApi.getConfiguredProvider).toBe("function");
  });

  test("getConfiguredProvider is in the shim-rebound runtime surface", () => {
    // The boot-time shim re-binds every name in PLUGIN_API_EXPORTS from the
    // globalThis-parked namespace, so a plugin importing the bare specifier
    // gets the assistant's real resolver (bound to its initialized provider
    // registry), not a disjoint, uninitialized module copy.
    expect(PLUGIN_API_EXPORTS).toContain("getConfiguredProvider");
  });
});
