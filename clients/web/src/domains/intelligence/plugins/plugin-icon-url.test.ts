import { describe, expect, test } from "bun:test";

import { buildPluginIconUrl } from "./plugin-icon-url";

describe("buildPluginIconUrl", () => {
  test("builds the gateway-proxied icon endpoint URL with a cache-buster", () => {
    expect(buildPluginIconUrl("asst-1", "simple-memory", "abc123")).toBe(
      "/v1/assistants/asst-1/plugins/simple-memory/icon?v=abc123",
    );
  });

  test("URL-encodes the plugin name", () => {
    expect(buildPluginIconUrl("asst-1", "cool plugin", "v1")).toBe(
      "/v1/assistants/asst-1/plugins/cool%20plugin/icon?v=v1",
    );
  });

  test("URL-encodes the icon version", () => {
    expect(buildPluginIconUrl("asst-1", "memory", "a b/c")).toBe(
      "/v1/assistants/asst-1/plugins/memory/icon?v=a%20b%2Fc",
    );
  });
});
