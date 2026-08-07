/**
 * Route-level coverage for plugin-declared MCP servers appearing in
 * `internal_mcp_list` (what `assistant mcp list` renders).
 *
 * The unit tests in `plugins/__tests__/plugin-mcp-servers.test.ts` cover
 * reading `mcp.json`. This file covers the merge: that a plugin server
 * reaches the listing at all, that it is labelled with its origin, and
 * that an explicit `config.json` entry of the same id wins — the case
 * where getting precedence backwards would let a plugin silently
 * redirect a server the user configured by hand.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const mockConnect = jest.fn();
const mockDisconnect = jest.fn();

mock.module("../mcp/client.js", () => ({
  McpClient: class {
    get isConnected() {
      return true;
    }
    get lastError() {
      return null;
    }
    connect = mockConnect;
    disconnect = mockDisconnect;
  },
}));

mock.module("../mcp/mcp-auth-orchestrator.js", () => ({
  orchestrateMcpOAuthConnect: async () => ({
    auth_url: "",
    already_authenticated: false,
  }),
}));

mock.module("../mcp/mcp-auth-state.js", () => ({
  getMcpAuthState: () => null,
}));

mock.module("../mcp/mcp-oauth-provider.js", () => ({
  hasMcpOAuthTokens: async () => false,
  deleteMcpOAuthCredentials: async () => ({ ok: true, failedKeys: [] }),
}));

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
}));

import { setConfig } from "./helpers/set-config.js";

setConfig("mcp", {
  servers: {
    "from-config": {
      transport: { type: "streamable-http", url: "https://config.example/mcp" },
      enabled: true,
      defaultRiskLevel: "high",
      maxTools: 20,
    },
    // Deliberately shares an id with the `shadowed` plugin below.
    shadowed: {
      transport: { type: "streamable-http", url: "https://wins.example/mcp" },
      enabled: true,
      defaultRiskLevel: "low",
      maxTools: 20,
    },
  },
});

const { getWorkspacePluginsDir } = await import("../util/platform.js");
const { ROUTES } = await import("../runtime/routes/mcp-auth-routes.js");

const listHandler = ROUTES.find(
  (r: { operationId: string }) => r.operationId === "internal_mcp_list",
)!.handler;

interface ListedServer {
  id: string;
  source?: "config" | "plugin";
  pluginName?: string;
  defaultRiskLevel: string;
  transport: { type: string; url?: string };
}

function writePlugin(name: string, mcpJson: unknown): void {
  const dir = join(getWorkspacePluginsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name, version: "1.0.0" }),
  );
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcpJson));
}

async function listServers(): Promise<ListedServer[]> {
  const result = (await listHandler({})) as { servers: ListedServer[] };
  return result.servers;
}

describe("internal_mcp_list — plugin-declared servers", () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
    mkdirSync(getWorkspacePluginsDir(), { recursive: true });
  });

  test("a plugin's mcp.json server appears alongside config servers", async () => {
    writePlugin("unabyss", {
      mcpServers: {
        unabyss: { type: "streamable-http", url: "https://mcp.unabyss.com" },
      },
    });

    const servers = await listServers();
    const ids = servers.map((s) => s.id);
    expect(ids).toContain("from-config");
    expect(ids).toContain("unabyss");
  });

  test("plugin servers are labelled with their origin, config servers are not", async () => {
    writePlugin("unabyss", {
      mcpServers: {
        unabyss: { type: "streamable-http", url: "https://mcp.unabyss.com" },
      },
    });

    const servers = await listServers();
    const plugin = servers.find((s) => s.id === "unabyss")!;
    const config = servers.find((s) => s.id === "from-config")!;

    expect(plugin.source).toEqual("plugin");
    expect(plugin.pluginName).toEqual("unabyss");
    expect(config.source).toEqual("config");
    expect(config.pluginName).toBeUndefined();
  });

  test("a config.json server of the same id wins over the plugin's", async () => {
    writePlugin("shadowed", {
      mcpServers: {
        shadowed: { type: "streamable-http", url: "https://loses.example/mcp" },
      },
    });

    const servers = await listServers();
    const matches = servers.filter((s) => s.id === "shadowed");

    expect(matches).toHaveLength(1);
    expect(matches[0].source).toEqual("config");
    expect(matches[0].transport.url).toEqual("https://wins.example/mcp");
  });

  test("plugin servers default to high risk", async () => {
    writePlugin("unabyss", {
      mcpServers: {
        unabyss: { type: "streamable-http", url: "https://mcp.unabyss.com" },
      },
    });

    const servers = await listServers();
    expect(servers.find((s) => s.id === "unabyss")!.defaultRiskLevel).toEqual(
      "high",
    );
  });

  test("a malformed plugin manifest does not remove config servers", async () => {
    const dir = join(getWorkspacePluginsDir(), "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "broken", version: "1.0.0" }),
    );
    writeFileSync(join(dir, "mcp.json"), "{ not json");

    const servers = await listServers();
    expect(servers.map((s) => s.id)).toContain("from-config");
  });

  test("no plugins installed leaves the listing unchanged", async () => {
    const servers = await listServers();
    expect(servers.every((s) => s.source === "config")).toBe(true);
  });
});
