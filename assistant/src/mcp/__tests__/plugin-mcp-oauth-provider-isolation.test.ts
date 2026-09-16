import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

import type { McpOAuthCredentialTarget } from "../credential-target.js";

const store = new Map<string, string>();

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync: jest.fn(async (key: string) => store.get(key)),
  setSecureKeyAsync: jest.fn(async (key: string, value: string) => {
    store.set(key, value);
    return true;
  }),
  deleteSecureKeyAsync: jest.fn(async (key: string) =>
    store.delete(key) ? "deleted" : "not-found",
  ),
  listSecureKeysAsync: jest.fn(async () => ({
    accounts: [...store.keys()],
    unreachable: false,
  })),
}));

const { McpOAuthProvider } = await import("../mcp-oauth-provider.js");
const { pluginMcpOAuthCredentialTarget, workspaceMcpOAuthCredentialTarget } =
  await import("../credential-target.js");

function provider(
  serverId: string,
  url: string,
  credentialTarget: McpOAuthCredentialTarget,
) {
  return new McpOAuthProvider(serverId, url, false, { credentialTarget });
}

describe("McpOAuthProvider plugin credential isolation", () => {
  beforeEach(() => {
    store.clear();
  });

  test("round-trips across provider instances without crossing owners or workspace", async () => {
    const url = "https://mcp.example.com/a";
    const pluginA = pluginMcpOAuthCredentialTarget("plugin-a", "server", {
      type: "streamable-http",
      url,
    });
    const pluginB = pluginMcpOAuthCredentialTarget("plugin-b", "server", {
      type: "streamable-http",
      url,
    });
    const workspace = workspaceMcpOAuthCredentialTarget("plugin-a");

    await provider("plugin-a", url, pluginA).saveTokens({
      access_token: "plugin-a-token",
      token_type: "bearer",
    });

    expect(await provider("plugin-a", url, pluginA).tokens()).toMatchObject({
      access_token: "plugin-a-token",
    });
    expect(await provider("plugin-b", url, pluginB).tokens()).toBeUndefined();
    expect(await provider("plugin-a", url, workspace).tokens()).toBeUndefined();
  });

  test("an endpoint change cannot read or invalidate the old endpoint tokens", async () => {
    const oldUrl = "https://mcp.example.com/a";
    const newUrl = "https://mcp.example.com/b";
    const oldTarget = pluginMcpOAuthCredentialTarget("plugin-a", "server", {
      type: "streamable-http",
      url: oldUrl,
    });
    const newTarget = pluginMcpOAuthCredentialTarget("plugin-a", "server", {
      type: "streamable-http",
      url: newUrl,
    });
    await provider("plugin-a", oldUrl, oldTarget).saveTokens({
      access_token: "old-token",
      token_type: "bearer",
    });

    expect(
      await provider("plugin-a", newUrl, newTarget).tokens(),
    ).toBeUndefined();
    await provider("plugin-a", newUrl, newTarget).invalidateCredentials(
      "tokens",
    );
    expect(
      await provider("plugin-a", oldUrl, oldTarget).tokens(),
    ).toMatchObject({ access_token: "old-token" });
  });
});
