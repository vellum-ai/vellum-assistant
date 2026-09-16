import { beforeEach, describe, expect, jest, mock, test } from "bun:test";

const getServerState = jest.fn();

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

import { setWorkspaceMcp } from "./helpers/set-workspace-mcp.js";

// Seed the MCP server the list route reads from workspace mcp.json.
setWorkspaceMcp({
  test: {
    transport: {
      type: "streamable-http",
      url: "https://example.com/mcp",
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

mock.module("../mcp/mcp-auth-state.js", () => ({
  getMcpAuthState: () => null,
}));

mock.module("../mcp/mcp-oauth-provider.js", () => ({
  hasMcpOAuthTokens: async () => false,
  deleteMcpOAuthCredentials: async () => ({ ok: true, failedKeys: [] }),
}));

const { ROUTES } = await import("../runtime/routes/mcp-auth-routes.js");

const listHandler = ROUTES.find(
  (r: { operationId: string }) => r.operationId === "internal_mcp_list",
)!.handler;

describe("internal_mcp_list runtime status", () => {
  beforeEach(() => {
    getServerState.mockReset();
  });

  test("returns connected from the manager's recorded state", async () => {
    getServerState.mockReturnValue("connected");

    const result = (await listHandler({})) as {
      servers: { status: string }[];
    };
    expect(result.servers[0].status).toBe("connected");
  });

  test("returns needs-auth from the manager's recorded state", async () => {
    getServerState.mockReturnValue("needs-auth");

    const result = (await listHandler({})) as {
      servers: { status: string }[];
    };
    expect(result.servers[0].status).toBe("needs-auth");
  });

  test.each([undefined, "connecting", "error"])(
    "returns the legacy error status for runtime state %s",
    async (runtimeState) => {
      getServerState.mockReturnValue(runtimeState);

      const result = (await listHandler({})) as {
        servers: { status: string }[];
      };
      expect(result.servers[0].status).toBe("error");
    },
  );

  test("repeated reads do not connect or spawn a configured server", async () => {
    getServerState.mockReturnValue("connected");

    await listHandler({});
    await listHandler({});

    expect(getServerState).toHaveBeenCalledTimes(2);
    expect(getServerState).toHaveBeenCalledWith("test", "workspace");
  });
});
