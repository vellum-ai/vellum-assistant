import { describe, expect, jest, mock, test } from "bun:test";

// Mock secure-keys so McpOAuthProvider doesn't try to access the credential store
mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: jest.fn().mockResolvedValue(null),
  setSecureKeyAsync: jest.fn().mockResolvedValue(true),
  deleteSecureKeyAsync: jest.fn().mockResolvedValue("deleted"),
}));

mock.module("../config/env-registry.js", () => ({
  getDebugStdoutLogs: () => false,
  getIsContainerized: () => false,
  getIsPlatform: () => false,
  isPlatformRemote: () => false,
  getWorkspaceDirOverride: () => undefined,
  getBackupDirOverride: () => undefined,
  getBackupKeyPathOverride: () => undefined,
  getCpuLimit: () => undefined,
  getMinikubeStorageSize: () => undefined,
  getProfilerRunId: () => undefined,
  getProfilerMode: () => undefined,
  getProfilerMaxBytes: () => undefined,
  getProfilerMaxRuns: () => undefined,
  getProfilerMinFreeMb: () => undefined,
  checkUnrecognizedEnvVars: () => [],
}));

const { McpClient } = await import("../mcp/client.js");
const { createMcpTool } = await import("../tools/mcp/mcp-tool-factory.js");
const { RiskLevel } = await import("../permissions/types.js");

type ServerRisk = "low" | "medium" | "high";

function serverConfig(defaultRiskLevel: ServerRisk) {
  return {
    transport: { type: "stdio" as const, command: "echo", args: [] },
    enabled: true,
    defaultRiskLevel,
    maxTools: 100,
  };
}

function toolWithAnnotations(readOnlyHint?: boolean) {
  return {
    name: "get-summary",
    description: "Read a summary",
    inputSchema: { type: "object", properties: {} },
    ...(readOnlyHint === undefined ? {} : { annotations: { readOnlyHint } }),
  };
}

describe("MCP tool risk from readOnlyHint annotations", () => {
  const fakeManager = { callTool: jest.fn() } as never;

  test("readOnlyHint true on a medium-risk server lowers risk to Low", () => {
    const tool = createMcpTool(
      toolWithAnnotations(true),
      "fathom",
      serverConfig("medium"),
      fakeManager,
    );

    expect(tool.defaultRiskLevel).toBe(RiskLevel.Low);
  });

  test("readOnlyHint true on a high-risk server leaves risk at High", () => {
    const tool = createMcpTool(
      toolWithAnnotations(true),
      "untrusted",
      serverConfig("high"),
      fakeManager,
    );

    expect(tool.defaultRiskLevel).toBe(RiskLevel.High);
  });

  test("missing annotations keeps the server default risk", () => {
    const tool = createMcpTool(
      toolWithAnnotations(undefined),
      "fathom",
      serverConfig("medium"),
      fakeManager,
    );

    expect(tool.defaultRiskLevel).toBe(RiskLevel.Medium);
  });

  test("readOnlyHint false on a low-risk server keeps risk at Low", () => {
    const tool = createMcpTool(
      toolWithAnnotations(false),
      "trusted",
      serverConfig("low"),
      fakeManager,
    );

    expect(tool.defaultRiskLevel).toBe(RiskLevel.Low);
  });
});

describe("McpClient.listTools annotations passthrough", () => {
  test("carries server-declared annotations into McpToolInfo", async () => {
    const client = new McpClient("test-server");

    const listToolsSpy = jest.fn().mockResolvedValue({
      tools: [
        {
          name: "get-summary",
          description: "Read a summary",
          inputSchema: { type: "object", properties: {} },
          annotations: { readOnlyHint: true, title: "Get summary" },
        },
        {
          name: "delete-recording",
          description: "Delete a recording",
          inputSchema: { type: "object", properties: {} },
        },
      ],
    });

    (client as unknown as { connected: boolean }).connected = true;
    (client as unknown as { client: unknown }).client = {
      listTools: listToolsSpy,
    };

    const tools = await client.listTools();

    expect(tools[0]?.annotations).toEqual({
      readOnlyHint: true,
      title: "Get summary",
    });
    expect(tools[1]?.annotations).toBeUndefined();
  });
});
