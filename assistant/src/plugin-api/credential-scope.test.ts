import { describe, expect, test } from "bun:test";

import { credentialInPluginScope } from "./credential-scope.js";

describe("credentialInPluginScope", () => {
  test("allows every field under the plugin's own service", () => {
    expect(credentialInPluginScope("imessage", "imessage")).toBe(true);
    expect(credentialInPluginScope("acme", "acme")).toBe(true);
  });

  test("blocks another service, even when the field matches the plugin name", () => {
    expect(credentialInPluginScope("acme", "openai")).toBe(false);
    expect(credentialInPluginScope("imessage", "openai")).toBe(false);
  });
});
