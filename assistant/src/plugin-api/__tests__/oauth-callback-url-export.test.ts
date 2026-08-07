/**
 * Guards that `resolveOauthCallbackUrl` reaches plugins.
 *
 * The shim written into `<workspaceDir>/node_modules/@vellumai/plugin-api`
 * re-binds whatever `Object.keys()` finds on the plugin-api namespace, so an
 * export missing from `index.ts` is missing from every installed plugin with
 * no other signal than a plugin failing to import it.
 */

import { describe, expect, test } from "bun:test";

import { PLUGIN_API_EXPORTS } from "../../embedded/plugin-api.js";
import * as pluginApi from "../index.js";

describe("plugin-api OAuth callback export", () => {
  test("is exported from the plugin-api surface", () => {
    expect(typeof pluginApi.resolveOauthCallbackUrl).toEqual("function");
  });

  test("is carried into the generated shim's binding list", () => {
    expect(PLUGIN_API_EXPORTS).toContain("resolveOauthCallbackUrl");
  });

  test("takes no arguments, so a plugin cannot vary the URI", () => {
    // The value a Client ID Metadata Document publishes and the value the
    // host later authorizes with have to be the same string.
    expect(pluginApi.resolveOauthCallbackUrl.length).toEqual(0);
  });
});
