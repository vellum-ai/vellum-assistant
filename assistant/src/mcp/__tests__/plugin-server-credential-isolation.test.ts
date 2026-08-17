/**
 * A plugin-declared server must connect without resolving
 * `mcp:<serverId>:*` from the workspace credential store.
 *
 * A plugin controls both its server key and its URL, so a stored
 * credential whose id happens to match would otherwise be sent to an
 * endpoint the plugin chose. The listing route avoids this by never
 * probing a plugin server; the connect path avoids it by reading the
 * server's own `source`, so the rule cannot be lost by a caller that
 * forgets to pass something.
 */

import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const getSecureKeyAsync = jest.fn(async (_key: string) => "stored-oauth-token");
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

function httpServer(source: "workspace" | "plugin") {
  return {
    transport: { type: "streamable-http" as const, url: UNREACHABLE },
    enabled: true,
    defaultRiskLevel: "low" as const,
    maxTools: 20,
    source,
  };
}

describe("plugin-declared MCP servers", () => {
  beforeEach(() => {
    getSecureKeyAsync.mockClear();
    getMcpHeaders.mockClear();
  });

  test("connect without resolving workspace credentials", async () => {
    const manager = new McpServerManager();

    await manager.start({
      servers: { unabyss: httpServer("plugin") },
      globalMaxTools: 50,
    });

    expect(getMcpHeaders).not.toHaveBeenCalled();
    expect(getSecureKeyAsync).not.toHaveBeenCalled();
  });

  test("workspace servers keep resolving theirs", async () => {
    const manager = new McpServerManager();

    await manager.start({
      servers: { "from-workspace": httpServer("workspace") },
      globalMaxTools: 50,
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
        unabyss: httpServer("plugin"),
        "from-workspace": httpServer("workspace"),
      },
      globalMaxTools: 50,
    });

    const lookedUpIds = getMcpHeaders.mock.calls.map(([id]) => id);
    expect(lookedUpIds).toEqual(["from-workspace"]);
  });
});
