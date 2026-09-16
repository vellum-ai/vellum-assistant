/**
 * A plugin-declared server must connect with its plugin and endpoint-scoped
 * OAuth credentials without resolving `mcp:<serverId>:*` from the workspace
 * credential store.
 *
 * A plugin controls both its server key and its URL, so a stored
 * credential whose id happens to match would otherwise be sent to an
 * endpoint the plugin chose. The listing route avoids this by never
 * probing a plugin server; the connect path avoids it by reading the
 * server's own `source`, so the rule cannot be lost by a caller that
 * forgets to pass something.
 */

import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const getSecureKeyAsync = jest.fn(
  async (_key: string): Promise<string | null> => "stored-oauth-token",
);
const getMcpHeaders = jest.fn(async (_serverId: string) => ({
  Authorization: "Bearer workspace-secret",
}));

mock.module("../../security/secure-keys.js", () => ({
  getSecureKeyAsync,
  setSecureKeyAsync: jest.fn(async () => true),
  deleteSecureKeyAsync: jest.fn(async () => "deleted"),
}));

mock.module("../mcp-header-store.js", () => ({
  getMcpHeaders,
  setMcpHeaders: jest.fn(async () => {}),
  deleteMcpHeaders: jest.fn(async () => true),
}));

// `McpOAuthProvider` is left real: its constructor only assigns fields, and
// mocking the module here would bleed into the sibling provider tests.
const { McpServerManager } = await import("../manager.js");

/** Refused immediately, so `connect` fails after the credential lookups. */
const UNREACHABLE = "http://127.0.0.1:1/mcp";

function workspaceHttpServer() {
  return {
    transport: { type: "streamable-http" as const, url: UNREACHABLE },
    source: "workspace" as const,
  };
}

function pluginHttpServer(url = UNREACHABLE) {
  return {
    transport: { type: "streamable-http" as const, url },
    source: "plugin" as const,
    pluginName: "unabyss",
    serverKey: "unabyss",
  };
}

describe("plugin-declared MCP servers", () => {
  beforeEach(() => {
    getSecureKeyAsync.mockClear();
    getMcpHeaders.mockClear();
  });

  test("connect with plugin-scoped OAuth credentials", async () => {
    const manager = new McpServerManager();

    await manager.start({
      servers: { unabyss: pluginHttpServer() },
    });

    expect(getMcpHeaders).not.toHaveBeenCalled();
    expect(getSecureKeyAsync.mock.calls.length).toBeGreaterThan(0);
    expect(getSecureKeyAsync.mock.calls.map(([key]) => key)).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^mcp-plugin\/v1\/dW5hYnlzcw\/dW5hYnlzcw\/[a-f0-9]{64}\/tokens$/,
        ),
      ]),
    );
    expect(
      getSecureKeyAsync.mock.calls.some(
        ([key]) => key === "mcp:unabyss:tokens",
      ),
    ).toBe(false);
  });

  test("workspace servers keep resolving theirs", async () => {
    const manager = new McpServerManager();

    await manager.start({
      servers: { "from-workspace": workspaceHttpServer() },
    });

    expect(getMcpHeaders).toHaveBeenCalledWith("from-workspace");
    expect(getSecureKeyAsync).toHaveBeenCalledWith("mcp:from-workspace:tokens");
  });

  test("isolation is per-server, not per-start", async () => {
    // Both kinds start together in one call — the plugin one must not
    // widen credential access for the workspace one, or vice versa.
    const manager = new McpServerManager();

    await manager.start({
      servers: {
        unabyss: pluginHttpServer(),
        "from-workspace": workspaceHttpServer(),
      },
    });

    const lookedUpIds = getMcpHeaders.mock.calls.map(([id]) => id);
    expect(lookedUpIds).toEqual(["from-workspace"]);
  });

  test("does not reuse an OAuth provider after the endpoint changes", async () => {
    const { McpClient } = await import("../client.js");
    const endpointA = "https://mcp.example.com/a";
    const endpointB = "https://mcp.example.com/b";
    getSecureKeyAsync.mockImplementation(async (key: string) =>
      key.endsWith("/tokens") &&
      key.includes("mcp-plugin/") &&
      getSecureKeyAsync.mock.calls.length === 1
        ? "stored-oauth-token"
        : null,
    );
    const client = new McpClient("unabyss", pluginHttpServer(endpointA));
    const providers: unknown[] = [];
    (client as any).createTransport = () => {
      providers.push((client as any).oauthProvider);
      return {};
    };
    (client as any).client.connect = async () => {};
    (client as any).client.close = async () => {};

    await client.connect({ type: "streamable-http", url: endpointA });
    await client.disconnect();
    await client.connect({ type: "streamable-http", url: endpointB });

    expect(providers[0]).not.toBeNull();
    expect(providers[1]).toBeNull();
  });
});
