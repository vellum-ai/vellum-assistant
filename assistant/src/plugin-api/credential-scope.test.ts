import { describe, expect, test } from "bun:test";

import { credentialInPluginScope } from "./credential-scope.js";

describe("credentialInPluginScope", () => {
  test("allows the documented field-owned shape", () => {
    expect(credentialInPluginScope("acme", "openai", "acme")).toBe(true);
    expect(credentialInPluginScope("acme", "stripe", "acme")).toBe(true);
  });

  test("allows a plugin to own every field under its own service", () => {
    expect(credentialInPluginScope("imessage", "imessage", "api_key")).toBe(
      true,
    );
    expect(
      credentialInPluginScope("imessage", "imessage", "photon_project_id"),
    ).toBe(true);
  });

  test("blocks a plugin from another service's generic fields", () => {
    expect(credentialInPluginScope("acme", "openai", "api_key")).toBe(false);
    expect(credentialInPluginScope("imessage", "openai", "api_key")).toBe(
      false,
    );
  });
});
