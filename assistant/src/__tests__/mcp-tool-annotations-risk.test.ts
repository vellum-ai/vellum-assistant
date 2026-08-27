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

type ServerRisk = "low" | "medium" | "high";

function serverConfig(defaultRiskLevel: ServerRisk) {
  return {
    transport: { type: "stdio" as const, command: "echo", args: [] },
    enabled: true,
    defaultRiskLevel,
    maxTools: 100,
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

  function riskFor(server: ServerRisk, annotations?: RiskAnnotations) {
    return createMcpTool(
      toolWithAnnotations(annotations),
      "server",
      serverConfig(server),
      fakeManager,
    ).defaultRiskLevel;
  }

  test("no annotations keeps the server level", () => {
    expect(riskFor("low")).toBe(RiskLevel.Low);
    expect(riskFor("medium")).toBe(RiskLevel.Medium);
    expect(riskFor("high")).toBe(RiskLevel.High);
  });

  test("readOnlyHint steps down from the medium default", () => {
    expect(riskFor("medium", { readOnlyHint: true })).toBe(RiskLevel.Low);
  });

  test("readOnlyHint cannot lower a server the user pinned to high", () => {
    expect(riskFor("high", { readOnlyHint: true })).toBe(RiskLevel.High);
  });

  test("readOnlyHint cannot step below low", () => {
    expect(riskFor("low", { readOnlyHint: true })).toBe(RiskLevel.Low);
  });

  test("destructiveHint steps up one level", () => {
    expect(riskFor("low", { destructiveHint: true })).toBe(RiskLevel.Medium);
    expect(riskFor("medium", { destructiveHint: true })).toBe(RiskLevel.High);
  });

  test("destructiveHint cannot step above high", () => {
    expect(riskFor("high", { destructiveHint: true })).toBe(RiskLevel.High);
  });

  test("destructiveHint wins when a server sends both", () => {
    expect(
      riskFor("medium", { readOnlyHint: true, destructiveHint: true }),
    ).toBe(RiskLevel.High);
  });

  test("hints set to false leave the server level alone", () => {
    expect(
      riskFor("medium", { readOnlyHint: false, destructiveHint: false }),
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
