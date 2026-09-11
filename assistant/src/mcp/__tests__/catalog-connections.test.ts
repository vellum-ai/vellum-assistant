import { beforeEach, describe, expect, mock, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import { loadRawConfig } from "../../config/loader.js";
import {
  STANDARD_MCP_SCHEMA_URL,
  STANDARD_PLUGIN_SCHEMA_URL,
  standardDefinitionDigest,
  type StandardDocuments,
} from "../standard-definitions.js";

const documents = {
  plugin: { $schema: STANDARD_PLUGIN_SCHEMA_URL, name: "example" },
  mcp: {
    $schema: STANDARD_MCP_SCHEMA_URL,
    mcpServers: {
      example: { type: "streamable-http", url: "https://example.com/mcp" },
    },
  },
} satisfies StandardDocuments;
const entry = {
  id: "example",
  serverKey: "example",
  documents,
  definitionDigest: standardDefinitionDigest(documents),
  setup: { mode: "oauth" },
};
let entries = [entry];
const reload = mock(async () => ({ success: true }));
const publish = mock(async () => {});
mock.module("../catalog.js", () => ({ getMcpCatalog: () => entries }));
mock.module("../../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: reload,
}));
mock.module("../sync.js", () => ({ publishMcpChanged: publish }));

const { connectMcpCatalogEntry } = await import("../catalog-connections.js");
const request = {
  catalogId: entry.id,
  serverKey: entry.serverKey,
  definitionDigest: entry.definitionDigest,
};

describe("catalog connection identity", () => {
  beforeEach(() => {
    entries = [entry];
    entry.setup.mode = "oauth";
    reload.mockClear();
    publish.mockClear();
    setConfig("mcp", {
      servers: {
        custom: {
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
          },
        },
      },
    });
  });

  test("concurrent clicks share one saved instance without merging matching custom URLs", async () => {
    const [first, second] = await Promise.all([
      connectMcpCatalogEntry(request),
      connectMcpCatalogEntry(request),
    ]);
    expect(first.serverId).toBe(second.serverId);
    expect([first.created, second.created]).toEqual([true, false]);
    const mcp = loadRawConfig().mcp as { servers: Record<string, unknown> };
    expect(Object.keys(mcp.servers)).toHaveLength(2);
    expect(mcp.servers[first.serverId]).toEqual({
      transport: documents.mcp.mcpServers.example,
      catalog: {
        id: "example",
        serverKey: "example",
        definitionDigest: entry.definitionDigest,
      },
    });
    expect(reload).toHaveBeenCalledTimes(1);
    expect(publish).toHaveBeenCalledTimes(1);
  });

  test("rejects stale definitions and unknown catalog identities before writing", async () => {
    await expect(
      connectMcpCatalogEntry({ ...request, definitionDigest: "0".repeat(64) }),
    ).rejects.toThrow("changed");
    await expect(
      connectMcpCatalogEntry({ ...request, catalogId: "unknown" }),
    ).rejects.toThrow("not available");
    expect(
      Object.keys((loadRawConfig().mcp as { servers: object }).servers),
    ).toEqual(["custom"]);
    expect(reload).not.toHaveBeenCalled();
  });

  test("catalog refresh never silently replaces an authorized instance's endpoint", async () => {
    const first = await connectMcpCatalogEntry(request);
    const nextDocuments = {
      ...documents,
      mcp: {
        ...documents.mcp,
        mcpServers: {
          example: {
            type: "streamable-http" as const,
            url: "https://new.example.com/mcp",
          },
        },
      },
    };
    const next = {
      ...entry,
      documents: nextDocuments,
      definitionDigest: standardDefinitionDigest(nextDocuments),
    };
    entries = [next];
    const retried = await connectMcpCatalogEntry({
      ...request,
      definitionDigest: next.definitionDigest,
    });
    expect(retried).toEqual({ serverId: first.serverId, created: false });
    const saved = (
      loadRawConfig().mcp as {
        servers: Record<string, { transport: { url: string } }>;
      }
    ).servers[first.serverId];
    expect(saved.transport.url).toBe("https://example.com/mcp");
  });

  test("manual setup must be acknowledged before creating a connection", async () => {
    entry.setup.mode = "manual";
    await expect(connectMcpCatalogEntry(request)).rejects.toThrow(
      "setup requirements",
    );
    expect(
      (await connectMcpCatalogEntry({ ...request, setupAcknowledged: true }))
        .created,
    ).toBe(true);
  });
});
