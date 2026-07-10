import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { McpServerConfig } from "../../../config/schemas/mcp.js";
import type { McpServerManager } from "../../../mcp/manager.js";
import type { ToolContext } from "../../types.js";

// Test double for the auth classifier — the production regex is exercised by
// its own tests; here we only need a deterministic auth/non-auth split.
mock.module("../../../mcp/client.js", () => ({
  isAuthRelatedError: (err: unknown) =>
    err instanceof Error &&
    /\b(401|unauthorized|authorizationCode is required)\b/i.test(err.message),
}));

let refreshResult = false;
let refreshCalls: Array<{ serverId: string; url: string }> = [];
mock.module("../../../mcp/mcp-token-refresh.js", () => ({
  refreshMcpTokens: async (serverId: string, url: string) => {
    refreshCalls.push({ serverId, url });
    return refreshResult;
  },
}));

const { createMcpTool } = await import("../mcp-tool-factory.js");

const SERVER_ID = "srv-auth";
const SERVER_URL = "https://mcp.example.com/mcp";

const serverConfig = {
  transport: { type: "streamable-http", url: SERVER_URL },
  defaultRiskLevel: "low",
} as unknown as McpServerConfig;

const metadata = {
  name: "do_thing",
  description: "Does a thing",
  inputSchema: { type: "object", properties: {} },
};

const context = { signal: undefined } as unknown as ToolContext;

function makeManager(callTool: McpServerManager["callTool"]): McpServerManager {
  return { callTool } as unknown as McpServerManager;
}

const AUTH_ERROR = new Error(
  "Either provider.prepareTokenRequest() or authorizationCode is required",
);

describe("createMcpTool auth-error handling", () => {
  beforeEach(() => {
    refreshResult = false;
    refreshCalls = [];
  });

  test("auth error + successful refresh → retries and returns the retry result", async () => {
    refreshResult = true;
    let calls = 0;
    const manager = makeManager((async () => {
      calls++;
      if (calls === 1) {
        throw AUTH_ERROR;
      }
      return { content: "recovered", isError: false };
    }) as McpServerManager["callTool"]);

    const tool = createMcpTool(metadata, SERVER_ID, serverConfig, manager);
    const result = await tool.execute({}, context);

    expect(result.isError).toBe(false);
    expect(result.content).toBe("recovered");
    expect(calls).toBe(2);
    expect(refreshCalls).toEqual([{ serverId: SERVER_ID, url: SERVER_URL }]);
  });

  test("auth error + no refresh available → returns re-auth instruction", async () => {
    refreshResult = false;
    let calls = 0;
    const manager = makeManager((async () => {
      calls++;
      throw AUTH_ERROR;
    }) as McpServerManager["callTool"]);

    const tool = createMcpTool(metadata, SERVER_ID, serverConfig, manager);
    const result = await tool.execute({}, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`assistant mcp auth ${SERVER_ID}`);
    expect(result.content).toContain("needs re-authentication");
    expect(calls).toBe(1);
  });

  test("auth error + refresh but retry still fails auth → returns re-auth instruction", async () => {
    refreshResult = true;
    let calls = 0;
    const manager = makeManager((async () => {
      calls++;
      throw AUTH_ERROR;
    }) as McpServerManager["callTool"]);

    const tool = createMcpTool(metadata, SERVER_ID, serverConfig, manager);
    const result = await tool.execute({}, context);

    expect(result.isError).toBe(true);
    expect(result.content).toContain(`assistant mcp auth ${SERVER_ID}`);
    expect(calls).toBe(2);
  });

  test("auth error + refresh but retry fails with a non-auth error → reports that error", async () => {
    refreshResult = true;
    let calls = 0;
    const manager = makeManager((async () => {
      calls++;
      if (calls === 1) {
        throw AUTH_ERROR;
      }
      throw new Error("connection reset");
    }) as McpServerManager["callTool"]);

    const tool = createMcpTool(metadata, SERVER_ID, serverConfig, manager);
    const result = await tool.execute({}, context);

    expect(result.isError).toBe(true);
    expect(result.content).toBe("MCP tool execution failed: connection reset");
    expect(calls).toBe(2);
  });

  test("non-auth error → generic failure message, no refresh attempted", async () => {
    const manager = makeManager((async () => {
      throw new Error("connection reset");
    }) as McpServerManager["callTool"]);

    const tool = createMcpTool(metadata, SERVER_ID, serverConfig, manager);
    const result = await tool.execute({}, context);

    expect(result.isError).toBe(true);
    expect(result.content).toBe("MCP tool execution failed: connection reset");
    expect(refreshCalls).toHaveLength(0);
  });

  test("success passes through unchanged", async () => {
    const manager = makeManager((async () => ({
      content: "ok",
      isError: false,
    })) as McpServerManager["callTool"]);

    const tool = createMcpTool(metadata, SERVER_ID, serverConfig, manager);
    const result = await tool.execute({}, context);

    expect(result).toEqual({ content: "ok", isError: false });
    expect(refreshCalls).toHaveLength(0);
  });
});
