import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { AGENT_PLUGINS_MCP_SCHEMA_URL } from "../../../mcp/spec-schema.js";
import { extractWorkspaceMcpJsonMigration } from "../154-extract-workspace-mcp-json.js";
import { WORKSPACE_MIGRATIONS } from "../registry.js";

function workspaceWith(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "extract-workspace-mcp-"));
  writeFileSync(join(dir, "config.json"), JSON.stringify(config, null, 2));
  return dir;
}

function readJson(dir: string, name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, name), "utf8")) as Record<
    string,
    unknown
  >;
}

describe("154-extract-workspace-mcp-json", () => {
  test("has the next migration id and is registered last", () => {
    expect(extractWorkspaceMcpJsonMigration.id).toBe(
      "154-extract-workspace-mcp-json",
    );
    expect(WORKSPACE_MIGRATIONS.at(-1)?.id).toBe(
      "154-extract-workspace-mcp-json",
    );
  });

  test("moves servers into a spec-pure mcp.json and drops mcp from config", () => {
    const dir = workspaceWith({
      llm: { activeProfile: "balanced" },
      mcp: {
        servers: {
          remote: {
            transport: {
              type: "streamable-http",
              url: "https://example.com/mcp",
            },
          },
          local: {
            transport: {
              type: "stdio",
              command: "npx",
              args: ["-y", "srv"],
              env: { DATA_DIR: "/tmp" },
            },
          },
        },
      },
    });

    extractWorkspaceMcpJsonMigration.run(dir);

    expect(readJson(dir, "config.json")).toEqual({
      llm: { activeProfile: "balanced" },
    });
    expect(readJson(dir, "mcp.json")).toEqual({
      $schema: AGENT_PLUGINS_MCP_SCHEMA_URL,
      mcpServers: {
        remote: {
          type: "streamable-http",
          url: "https://example.com/mcp",
        },
        local: {
          type: "stdio",
          command: "npx",
          args: ["-y", "srv"],
          env: { DATA_DIR: "/tmp" },
        },
      },
    });
  });

  test("copies leftover transport headers onto the spec entry", () => {
    const dir = workspaceWith({
      mcp: {
        servers: {
          remote: {
            transport: {
              type: "sse",
              url: "https://example.com/sse",
              headers: { Authorization: "Bearer leftover" },
            },
          },
        },
      },
    });

    extractWorkspaceMcpJsonMigration.run(dir);

    expect(readJson(dir, "mcp.json")).toEqual({
      $schema: AGENT_PLUGINS_MCP_SCHEMA_URL,
      mcpServers: {
        remote: {
          type: "sse",
          url: "https://example.com/sse",
          headers: { Authorization: "Bearer leftover" },
        },
      },
    });
  });

  test("keeps existing mcp.json ids and fills only the missing ones", () => {
    const dir = workspaceWith({
      mcp: {
        servers: {
          fromConfig: {
            transport: {
              type: "streamable-http",
              url: "https://config.example/mcp",
            },
          },
          shared: {
            transport: {
              type: "streamable-http",
              url: "https://config-loses.example/mcp",
            },
          },
        },
      },
    });
    writeFileSync(
      join(dir, "mcp.json"),
      JSON.stringify({
        $schema: AGENT_PLUGINS_MCP_SCHEMA_URL,
        mcpServers: {
          shared: {
            type: "streamable-http",
            url: "https://file-wins.example/mcp",
          },
        },
      }),
    );

    extractWorkspaceMcpJsonMigration.run(dir);

    expect(readJson(dir, "mcp.json")).toEqual({
      $schema: AGENT_PLUGINS_MCP_SCHEMA_URL,
      mcpServers: {
        fromConfig: {
          type: "streamable-http",
          url: "https://config.example/mcp",
        },
        shared: {
          type: "streamable-http",
          url: "https://file-wins.example/mcp",
        },
      },
    });
    expect(readJson(dir, "config.json")).toEqual({});
  });

  test("extracts a leftover array of servers", () => {
    const dir = workspaceWith({
      mcp: {
        servers: [
          {
            name: "legacy",
            transport: { type: "sse", url: "https://example.com/sse" },
          },
        ],
      },
    });

    extractWorkspaceMcpJsonMigration.run(dir);

    expect(readJson(dir, "mcp.json")).toEqual({
      $schema: AGENT_PLUGINS_MCP_SCHEMA_URL,
      mcpServers: {
        legacy: { type: "sse", url: "https://example.com/sse" },
      },
    });
  });

  test("is a no-op when mcp is already gone", () => {
    const dir = workspaceWith({ llm: {} });
    const before = readFileSync(join(dir, "config.json"), "utf8");

    extractWorkspaceMcpJsonMigration.run(dir);

    expect(readFileSync(join(dir, "config.json"), "utf8")).toBe(before);
    expect(existsSync(join(dir, "mcp.json"))).toBe(false);
  });

  test("drops an empty mcp key without creating mcp.json", () => {
    const dir = workspaceWith({ mcp: { servers: {} } });

    extractWorkspaceMcpJsonMigration.run(dir);

    expect(readJson(dir, "config.json")).toEqual({});
    expect(existsSync(join(dir, "mcp.json"))).toBe(false);
  });
});
