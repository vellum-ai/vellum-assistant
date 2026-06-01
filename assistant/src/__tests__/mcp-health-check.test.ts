import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
let mockIsConnected = true;
let mockLastError: Error | null = null;

mock.module("../mcp/client.js", () => ({
  McpClient: class {
    get isConnected() {
      return mockIsConnected;
    }
    get lastError() {
      return mockLastError;
    }
    connect = mockConnect;
    disconnect = mockDisconnect;
  },
}));

const mockConfig = {
  mcp: {
    servers: {
      test: {
        transport: {
          type: "streamable-http",
          url: "https://example.com/mcp",
        },
        enabled: true,
        defaultRiskLevel: "high",
        maxTools: 20,
      },
    },
  },
};
mock.module("../config/loader.js", () => ({
  loadRawConfig: () => mockConfig,
  saveRawConfig: () => {},
  // route-policy → config/env transitively imports `getConfig`; stub it
  // here so the mock surface matches what consumers expect.
  getConfig: () => mockConfig,
  getConfigReadOnly: () => mockConfig,
}));

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
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
  deleteMcpOAuthCredentials: async () => {},
}));

const { ROUTES } = await import("../runtime/routes/mcp-auth-routes.js");

const listHandler = ROUTES.find(
  (r: { operationId: string }) => r.operationId === "internal_mcp_list",
)!.handler;

describe("checkServerHealth (via internal_mcp_list route)", () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockIsConnected = true;
    mockLastError = null;
  });

  test("returns Connected when server connects successfully", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);

    const result = (await listHandler({})) as {
      servers: { status: string }[];
    };
    expect(result.servers[0].status).toContain("Connected");
    expect(mockDisconnect).toHaveBeenCalled();
  });

  test("returns Needs authentication when isConnected is false and no lastError", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockIsConnected = false;

    const result = (await listHandler({})) as {
      servers: { status: string }[];
    };
    expect(result.servers[0].status).toContain("Needs authentication");
  });

  test("returns Error when connect fails with lastError", async () => {
    mockConnect.mockResolvedValue(undefined);
    mockIsConnected = false;
    mockLastError = new Error("Connection refused");
    mockDisconnect.mockResolvedValue(undefined);

    const result = (await listHandler({})) as {
      servers: { status: string }[];
    };
    expect(result.servers[0].status).toContain("Error");
    expect(result.servers[0].status).toContain("Connection refused");
  });
});
