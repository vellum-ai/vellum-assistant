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
  getWorkspaceDirOverride: () => process.env.VELLUM_WORKSPACE_DIR,
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

type ServerSource = "workspace" | "plugin";

function serverConfig(source: ServerSource) {
  return {
    transport: { type: "stdio" as const, command: "echo", args: [] },
    source,
  };
}

interface RiskAnnotations {
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
}

function toolWithAnnotations(annotations?: RiskAnnotations) {
  return {
    name: "get-summary",
    description: "Read a summary",
    inputSchema: { type: "object", properties: {} },
    ...(annotations === undefined ? {} : { annotations }),
  };
}

describe("MCP tool risk from annotations", () => {
  const fakeManager = { callTool: jest.fn() } as never;

  function riskFor(source: ServerSource, annotations?: RiskAnnotations) {
    return createMcpTool(
      toolWithAnnotations(annotations),
      "server",
      serverConfig(source),
      fakeManager,
    ).defaultRiskLevel;
  }

  test("no annotations keeps the origin level", () => {
    expect(riskFor("plugin")).toBe(RiskLevel.Low);
    expect(riskFor("workspace")).toBe(RiskLevel.Medium);
  });

  test("readOnlyHint steps down from the workspace medium default", () => {
    expect(riskFor("workspace", { readOnlyHint: true })).toBe(RiskLevel.Low);
  });

  test("readOnlyHint cannot step below the plugin low default", () => {
    expect(riskFor("plugin", { readOnlyHint: true })).toBe(RiskLevel.Low);
  });

  test("destructiveHint steps up one level", () => {
    expect(riskFor("plugin", { destructiveHint: true })).toBe(RiskLevel.Medium);
    expect(riskFor("workspace", { destructiveHint: true })).toBe(
      RiskLevel.High,
    );
  });

  test("destructiveHint wins when a server sends both", () => {
    expect(
      riskFor("workspace", { readOnlyHint: true, destructiveHint: true }),
    ).toBe(RiskLevel.High);
  });

  test("hints set to false leave the origin level alone", () => {
    expect(
      riskFor("workspace", { readOnlyHint: false, destructiveHint: false }),
    ).toBe(RiskLevel.Medium);
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
