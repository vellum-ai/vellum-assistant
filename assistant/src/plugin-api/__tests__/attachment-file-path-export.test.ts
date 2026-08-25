/**
 * Guards that `getAttachmentFilePath` reaches plugins.
 *
 * The shim written into `<workspaceDir>/node_modules/@vellumai/plugin-api`
 * re-binds whatever `Object.keys()` finds on the plugin-api namespace, so an
 * export missing from `index.ts` is missing from every installed plugin with
 * no other signal than a plugin failing to import it.
 */

import { describe, expect, test } from "bun:test";

import { PLUGIN_API_EXPORTS } from "../../embedded/plugin-api.js";
import { getFilePathForAttachment } from "../../persistence/attachments-store.js";
import * as pluginApi from "../index.js";

describe("plugin-api attachment file path export", () => {
  test("is exported from the plugin-api surface", () => {
    expect(typeof pluginApi.getAttachmentFilePath).toEqual("function");
  });

  test("is carried into the generated shim's binding list", () => {
    expect(PLUGIN_API_EXPORTS).toContain("getAttachmentFilePath");
  });

  test("is the attachment store's own lookup, not a reimplementation", () => {
    expect(pluginApi.getAttachmentFilePath).toBe(getFilePathForAttachment);
  });
});
