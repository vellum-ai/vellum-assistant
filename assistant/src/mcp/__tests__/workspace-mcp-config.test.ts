import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, test } from "bun:test";

import { AGENT_PLUGINS_MCP_SCHEMA_URL } from "../spec-schema.js";
import {
  loadWorkspaceMcpConfig,
  overlayWorkspaceMcpForConfigRead,
  readWorkspaceMcpFile,
  saveWorkspaceMcpConfig,
} from "../workspace-mcp-config.js";

function mcpPath(): string {
  return join(process.env.VELLUM_WORKSPACE_DIR!, "mcp.json");
}

describe("workspace mcp.json", () => {
  beforeEach(() => {
    mkdirSync(process.env.VELLUM_WORKSPACE_DIR!, { recursive: true });
    rmSync(mcpPath(), { force: true });
  });

  test("missing file is an empty server map", () => {
    expect(loadWorkspaceMcpConfig()).toEqual({ servers: {} });
    expect(readWorkspaceMcpFile().fileState).toBe("missing");
  });

  test("round-trips a spec document without wrapping transport", () => {
    saveWorkspaceMcpConfig({
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
          },
        },
      },
    });

    expect(JSON.parse(readFileSync(mcpPath(), "utf8"))).toEqual({
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
        },
      },
    });
    expect(loadWorkspaceMcpConfig()).toEqual({
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
          },
        },
      },
    });
  });

  test("does not persist transport headers", () => {
    saveWorkspaceMcpConfig({
      servers: {
        remote: {
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
            headers: { Authorization: "Bearer secret" },
          },
        },
      },
    });

    const onDisk = readFileSync(mcpPath(), "utf8");
    expect(onDisk).not.toContain("secret");
    expect(loadWorkspaceMcpConfig().servers.remote?.transport).toEqual({
      type: "streamable-http",
      url: "https://example.com/mcp",
    });
  });

  test("invalid file does not throw on read and refuses a later write", () => {
    mkdirSync(process.env.VELLUM_WORKSPACE_DIR!, { recursive: true });
    writeFileSync(mcpPath(), "{ not json");

    expect(loadWorkspaceMcpConfig()).toEqual({ servers: {} });
    expect(readWorkspaceMcpFile().fileState).toBe("invalid");
    expect(() => saveWorkspaceMcpConfig({ servers: {} })).toThrow(/invalid JSON/);
  });

  test("overlay projects transport-only servers for config reads", () => {
    saveWorkspaceMcpConfig({
      servers: {
        remote: {
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
          },
        },
      },
    });

    const config: Record<string, unknown> = { llm: { activeProfile: "balanced" } };
    overlayWorkspaceMcpForConfigRead(config);
    expect(config.mcp).toEqual({
      servers: {
        remote: {
          transport: {
            type: "streamable-http",
            url: "https://example.com/mcp",
          },
        },
      },
    });
  });
});
