import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const mockConnect = jest.fn();
const mockDisconnect = jest.fn();
let mockIsConnected = true;
let mockLastError: Error | null = null;
let runtimeState: string | undefined;
mock.module("../mcp/manager.js", () => ({
  getMcpServerManager: () => ({ getServerState: () => runtimeState }),
}));

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

import { setConfig } from "./helpers/set-config.js";

// Seed the MCP server the list route reads via `loadRawConfig()` into the
// workspace config for real.
setConfig("mcp", {
  servers: {
    test: {
      transport: {
        type: "streamable-http",
        url: "https://example.com/mcp",
      },
    },
  },
});

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
}));

mock.module("../mcp/mcp-auth-orchestrator.js", () => ({
  orchestrateMcpOAuthConnect: async () => ({
    auth_url: "",
    already_authenticated: false,
  }),
}));

mock.module("../mcp/mcp-oauth-provider.js", () => ({
  hasMcpOAuthTokens: async () => false,
  deleteMcpOAuthCredentials: async () => ({ ok: true, failedKeys: [] }),
}));

const { ROUTES } = await import("../runtime/routes/mcp-auth-routes.js");

const listHandler = ROUTES.find(
  (r: { operationId: string }) => r.operationId === "internal_mcp_list",
)!.handler;

describe("passive runtime state (via internal_mcp_list route)", () => {
  beforeEach(() => {
    mockConnect.mockReset();
    mockDisconnect.mockReset();
    mockIsConnected = true;
    mockLastError = null;
    runtimeState = undefined;
  });

  test("returns connected only when runtime reports connected", async () => {
    runtimeState = "connected";
    mockConnect.mockResolvedValue(undefined);
    mockDisconnect.mockResolvedValue(undefined);

    const result = (await listHandler({})) as {
      servers: { status: string }[];
    };
    expect(result.servers[0].status).toBe("connected");
    expect(mockDisconnect).not.toHaveBeenCalled();
    expect(mockConnect).not.toHaveBeenCalled();
  });

  test("returns recorded needs-auth state", async () => {
    runtimeState = "needs-auth";
    mockConnect.mockResolvedValue(undefined);
    mockIsConnected = false;

    const result = (await listHandler({})) as {
      servers: { status: string }[];
    };
    expect(result.servers[0].status).toBe("needs-auth");
  });

  test("returns recorded error state", async () => {
    runtimeState = "error";
    mockConnect.mockResolvedValue(undefined);
    mockIsConnected = false;
    mockLastError = new Error("Connection refused");
    mockDisconnect.mockResolvedValue(undefined);

    const result = (await listHandler({})) as {
      servers: { status: string }[];
    };
    expect(result.servers[0].status).toBe("error");
  });
  test("repeated reads never connect unstarted remote or stdio servers", async () => {
    const result = (await listHandler({})) as {
      servers: { status: string; lifecycleState: string }[];
    };
    await listHandler({});
    expect(result.servers[0]).toMatchObject({
      status: "error",
      lifecycleState: "not-started",
    });
    expect(mockConnect).not.toHaveBeenCalled();
    expect(mockDisconnect).not.toHaveBeenCalled();
  });
  test("connecting is distinct from connected and uses a legacy status", async () => {
    runtimeState = "connecting";
    const result = (await listHandler({})) as {
      servers: { status: string; lifecycleState: string }[];
    };
    expect(result.servers[0]).toMatchObject({
      status: "error",
      lifecycleState: "connecting",
    });
  });
});
