/**
 * Route-level coverage for plugin-declared MCP servers appearing in
 * `internal_mcp_list` (what `assistant mcp list` renders).
 *
 * The unit tests in `plugins/__tests__/mcp-servers.test.ts` cover reading
 * `mcp.json`. This file covers the merge, and two properties that a
 * refactor could quietly break:
 *
 * 1. A workspace entry of the same id wins. Getting precedence backwards
 *    would let a plugin redirect a server the user configured by hand.
 * 2. A plugin server is never health-checked as a side effect of listing.
 *    OAuth status is read from the plugin and endpoint-scoped credential
 *    identity, while workspace static headers remain isolated.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const getServerState = jest.fn();
const hasMcpOAuthTokens = jest.fn(async (target: any) => {
  if (target.source === "plugin" && target.url === "not a url") {
    throw new TypeError("invalid URL");
  }
  return true;
});

mock.module("../mcp/client.js", () => ({
  McpClient: class {
    constructor() {
      throw new Error("list route must not construct an MCP client");
    }
  },
}));

mock.module("../mcp/manager.js", () => ({
  getMcpServerManager: () => ({ getServerState }),
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
  hasMcpOAuthTokens,
  deleteMcpOAuthCredentials: async () => ({ ok: true, failedKeys: [] }),
}));

mock.module("../mcp/mcp-header-store.js", () => ({
  getMcpHeaders: async () => ({ Authorization: "Bearer workspace-secret" }),
  setMcpHeaders: async () => {},
  deleteMcpHeaders: async () => true,
}));

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
}));

import { setWorkspaceMcp } from "./helpers/set-workspace-mcp.js";

setWorkspaceMcp({
  "from-workspace": {
    transport: { type: "streamable-http", url: "https://config.example/mcp" },
  },
  // Deliberately shares an id with the `shadowed` plugin below.
  shadowed: {
    transport: { type: "streamable-http", url: "https://wins.example/mcp" },
  },
});

const { getWorkspacePluginsDir } = await import("../util/platform.js");
const { ROUTES } = await import("../runtime/routes/mcp-auth-routes.js");

const listHandler = ROUTES.find(
  (r: { operationId: string }) => r.operationId === "internal_mcp_list",
)!.handler;

interface ListedServer {
  id: string;
  status: string;
  source?: "workspace" | "plugin";
  pluginName?: string;
  hasOAuth: boolean;
  hasStaticAuth: boolean;
  authType: string;
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

function writeStandardPlugin(name: string, mcpJson: unknown): void {
  const dir = join(getWorkspacePluginsDir(), name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "plugin.json"),
    JSON.stringify({
      $schema: "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json",
      name,
    }),
  );
  writeFileSync(join(dir, "mcp.json"), JSON.stringify(mcpJson));
}

function unabyssManifest(): unknown {
  return {
    mcpServers: {
      unabyss: { type: "streamable-http", url: "https://mcp.unabyss.com" },
    },
  };
}

async function listServers(): Promise<ListedServer[]> {
  const result = (await listHandler({})) as { servers: ListedServer[] };
  return result.servers;
}

describe("internal_mcp_list, plugin-declared servers", () => {
  beforeEach(() => {
    getServerState.mockReset();
    hasMcpOAuthTokens.mockClear();
    rmSync(getWorkspacePluginsDir(), { recursive: true, force: true });
    mkdirSync(getWorkspacePluginsDir(), { recursive: true });
  });

  test("a plugin's mcp.json server appears alongside workspace servers", async () => {
    writePlugin("unabyss", unabyssManifest());

    const ids = (await listServers()).map((s) => s.id);
    expect(ids).toContain("from-workspace");
    expect(ids).toContain("unabyss");
  });

  test("a standard-only plugin keeps its server identity", async () => {
    writeStandardPlugin("unabyss", unabyssManifest());

    const plugin = (await listServers()).find((s) => s.id === "unabyss")!;
    expect(plugin.source).toBe("plugin");
    expect(plugin.pluginName).toBe("unabyss");
  });

  test("plugin servers are labelled with their origin, workspace servers are not", async () => {
    writePlugin("unabyss", unabyssManifest());

    const servers = await listServers();
    const plugin = servers.find((s) => s.id === "unabyss")!;
    const workspace = servers.find((s) => s.id === "from-workspace")!;

    expect(plugin.source).toEqual("plugin");
    expect(plugin.pluginName).toEqual("unabyss");
    expect(workspace.source).toEqual("workspace");
    expect(workspace.pluginName).toBeUndefined();
  });

  test("a workspace server of the same id wins over the plugin's", async () => {
    writePlugin("shadowed", {
      mcpServers: {
        shadowed: { type: "streamable-http", url: "https://loses.example/mcp" },
      },
    });

    const matches = (await listServers()).filter((s) => s.id === "shadowed");

    expect(matches).toHaveLength(1);
    expect(matches[0].source).toEqual("workspace");
    expect(matches[0].transport.url).toEqual("https://wins.example/mcp");
  });

  test("plugin servers are not health-checked, so no credential can reach them", async () => {
    writePlugin("unabyss", unabyssManifest());

    const servers = await listServers();

    expect(servers.find((s) => s.id === "unabyss")!.status).toEqual("declared");
    expect(getServerState).toHaveBeenCalledWith("from-workspace", "workspace");
    expect(getServerState).toHaveBeenCalledWith("unabyss", "plugin");
  });

  test("plugin status uses only state recorded for the plugin source", async () => {
    writePlugin("unabyss", unabyssManifest());
    getServerState.mockImplementation(
      (serverId: string, source: "workspace" | "plugin") =>
        serverId === "unabyss" && source === "plugin" ? "connected" : undefined,
    );

    const plugin = (await listServers()).find((s) => s.id === "unabyss")!;
    expect(plugin.status).toBe("connected");
  });

  test("plugin servers report endpoint-scoped OAuth without static auth", async () => {
    writePlugin("unabyss", unabyssManifest());

    const plugin = (await listServers()).find((s) => s.id === "unabyss")!;
    expect(plugin.hasOAuth).toBe(true);
    expect(plugin.hasStaticAuth).toBe(false);
    expect(plugin.authType).toEqual("none");
    expect(hasMcpOAuthTokens).toHaveBeenCalledWith(
      expect.objectContaining({
        source: "plugin",
        pluginName: "unabyss",
        serverKey: "unabyss",
        url: "https://mcp.unabyss.com",
      }),
    );
  });

  test("workspace servers keep reporting their auth state", async () => {
    const workspace = (await listServers()).find(
      (s) => s.id === "from-workspace",
    )!;
    expect(workspace.hasOAuth).toBe(true);
    expect(workspace.hasStaticAuth).toBe(true);
  });

  test("a directory with no valid package.json is not advertised", async () => {
    // The runtime loader would never load it, and its stdio command must
    // not be reachable through the listing.
    const dir = join(getWorkspacePluginsDir(), "no-manifest");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        mcpServers: { evil: { type: "stdio", command: "touch" } },
      }),
    );

    const ids = (await listServers()).map((s) => s.id);
    expect(ids).not.toContain("no-manifest__evil");
    expect(ids).toContain("from-workspace");
  });

  test("a malformed plugin manifest does not remove workspace servers", async () => {
    const dir = join(getWorkspacePluginsDir(), "broken");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "broken", version: "1.0.0" }),
    );
    writeFileSync(join(dir, "mcp.json"), "{ not json");

    const ids = (await listServers()).map((s) => s.id);
    expect(ids).toContain("from-workspace");
  });

  test("an invalid plugin transport URL does not break the listing", async () => {
    writePlugin("bad-url", {
      mcpServers: {
        remote: { type: "streamable-http", url: "not a url" },
      },
    });

    const servers = await listServers();
    expect(servers.find((s) => s.id === "bad-url__remote")?.hasOAuth).toBe(
      false,
    );
    expect(servers.some((s) => s.id === "from-workspace")).toBe(true);
  });

  test("no plugins installed leaves the listing unchanged", async () => {
    const servers = await listServers();
    expect(servers.every((s) => s.source === "workspace")).toBe(true);
  });
});
