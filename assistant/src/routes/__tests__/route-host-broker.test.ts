import { describe, expect, test } from "bun:test";

import { dispatchRouteHostBrokerRequest } from "../route-host-broker.js";

const context = {
  pluginId: "example-plugin",
  pluginStorageDir: "/tmp/example-plugin-data",
};

describe("route host broker", () => {
  test("rejects request fields outside the closed contract", async () => {
    await expect(
      dispatchRouteHostBrokerRequest(
        { operation: "plugin.storage-dir", extra: true },
        context,
      ),
    ).rejects.toThrow();

    await expect(
      dispatchRouteHostBrokerRequest(
        { operation: "conversation.read" },
        context,
      ),
    ).rejects.toThrow();
  });
});
