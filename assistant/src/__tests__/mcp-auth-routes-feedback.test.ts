import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must precede imports that pull them in) ──────────────────────

let rawConfig: { mcp: { servers: Record<string, Record<string, unknown>> } };

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => rawConfig,
  saveRawConfig: (c: typeof rawConfig) => {
    rawConfig = c;
  },
  getConfig: () => rawConfig,
  getConfigReadOnly: () => rawConfig,
}));

let reloadResult: {
  success: boolean;
  servers?: Array<Record<string, unknown>>;
  error?: string;
};
const mockReload = mock(async () => reloadResult);

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: () => mockReload(),
}));

mock.module("../mcp/mcp-auth-orchestrator.js", () => ({
  orchestrateMcpOAuthConnect: async () => ({ auth_url: "https://x" }),
}));

mock.module("../mcp/mcp-auth-state.js", () => ({
  getMcpAuthState: () => null,
}));

mock.module("../mcp/mcp-oauth-provider.js", () => ({
  hasMcpOAuthTokens: async () => false,
  deleteMcpOAuthCredentials: async () => ({ ok: true, failedKeys: [] }),
}));

let clientConnected = true;
let clientLastError: Error | null = null;
const connectCalls: string[] = [];

mock.module("../mcp/client.js", () => ({
  McpClient: class {
    constructor(public id: string) {}
    async connect() {
      connectCalls.push(this.id);
    }
    get isConnected() {
      return clientConnected;
    }
    get lastError() {
      return clientLastError;
    }
    async disconnect() {}
  },
}));

let connectedServers: Set<string>;

mock.module("../mcp/manager.js", () => ({
  getMcpServerManager: () => ({
    isServerConnected: (id: string) => connectedServers.has(id),
  }),
}));

const secureStore = new Map<string, string>();
const realSecureKeys = await import("../security/secure-keys.js");

mock.module("../security/secure-keys.js", () => ({
  ...realSecureKeys,
  getSecureKeyAsync: async (k: string) => secureStore.get(k),
  setSecureKeyAsync: async (k: string, v: string) => {
    secureStore.set(k, v);
    return true;
  },
  deleteSecureKeyAsync: async (k: string) => {
    secureStore.delete(k);
    return "deleted";
  },
  getSecureKeyResultAsync: async (k: string) => ({
    value: secureStore.get(k),
    unreachable: false,
  }),
}));

// ── Import SUT after mocks ─────────────────────────────────────────────────────

const { ROUTES } = await import("../runtime/routes/mcp-auth-routes.js");

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route;
}

const httpServer = {
  transport: { type: "streamable-http", url: "https://srv.example.com/mcp" },
  enabled: true,
  defaultRiskLevel: "high",
};

beforeEach(() => {
  rawConfig = { mcp: { servers: {} } };
  reloadResult = { success: true, servers: [] };
  clientConnected = true;
  clientLastError = null;
  connectCalls.length = 0;
  connectedServers = new Set<string>();
  secureStore.clear();
  mockReload.mockClear();
});

describe("internal_mcp_reload — wait", () => {
  test("wait=true awaits reload and returns per-server status", async () => {
    reloadResult = {
      success: true,
      servers: [
        { id: "a", connected: true, toolCount: 2, tools: ["x", "y"] },
        { id: "b", connected: false, needsAuth: true, toolCount: 0, tools: [] },
        { id: "c", connected: false, error: "boom", toolCount: 0, tools: [] },
        { id: "d", connected: false, disabled: true, toolCount: 0, tools: [] },
      ],
    };

    const reload = findRoute("internal_mcp_reload");
    const result = await reload.handler({ body: { wait: true } });

    expect(mockReload).toHaveBeenCalledTimes(1);
    expect(result).toEqual({
      ok: true,
      servers: [
        { serverId: "a", connected: true },
        { serverId: "b", connected: false, needsAuth: true },
        { serverId: "c", connected: false, error: "boom" },
        { serverId: "d", connected: false, disabled: true },
      ],
    });
  });

  test("without wait it stays fire-and-forget", async () => {
    const reload = findRoute("internal_mcp_reload");
    const result = await reload.handler({ body: {} });

    expect(result).toEqual({ ok: true });
    await new Promise((r) => setTimeout(r, 0));
    expect(mockReload).toHaveBeenCalledTimes(1);
  });

  test("wait=true surfaces a top-level reload error", async () => {
    reloadResult = { success: false, error: "config broken", servers: [] };

    const reload = findRoute("internal_mcp_reload");
    const result = await reload.handler({ body: { wait: true } });

    expect(result).toEqual({ ok: true, servers: [], error: "config broken" });
  });
});

describe("internal_mcp_add — verification", () => {
  test("reports connected when the probe connects", async () => {
    clientConnected = true;
    const add = findRoute("internal_mcp_add");
    const result = await add.handler({
      body: {
        name: "srv",
        transportType: "streamable-http",
        url: "https://srv.example.com/mcp",
      },
    });

    expect(result).toEqual({ added: true, status: "connected" });
    expect(connectCalls).toEqual(["srv"]);
  });

  test("reports needs-auth when the probe is unauthenticated", async () => {
    clientConnected = false;
    clientLastError = null;
    const add = findRoute("internal_mcp_add");
    const result = await add.handler({
      body: {
        name: "srv",
        transportType: "streamable-http",
        url: "https://srv.example.com/mcp",
      },
    });

    expect(result).toEqual({ added: true, status: "needs-auth" });
  });

  test("reports error with the failure message", async () => {
    clientConnected = false;
    clientLastError = new Error("dns fail");
    const add = findRoute("internal_mcp_add");
    const result = await add.handler({
      body: {
        name: "srv",
        transportType: "streamable-http",
        url: "https://srv.example.com/mcp",
      },
    });

    expect(result).toEqual({ added: true, status: "error", error: "dns fail" });
  });

  test("verify:false skips the probe entirely", async () => {
    const add = findRoute("internal_mcp_add");
    const result = await add.handler({
      body: {
        name: "srv",
        transportType: "streamable-http",
        url: "https://srv.example.com/mcp",
        verify: false,
      },
    });

    expect(result).toEqual({ added: true });
    expect(connectCalls).toEqual([]);
  });

  test("a disabled server is not probed", async () => {
    const add = findRoute("internal_mcp_add");
    const result = await add.handler({
      body: {
        name: "srv",
        transportType: "streamable-http",
        url: "https://srv.example.com/mcp",
        disabled: true,
      },
    });

    expect(result).toEqual({ added: true });
    expect(connectCalls).toEqual([]);
  });
});

describe("internal_mcp_update — verification", () => {
  test("probes and reports status by default", async () => {
    rawConfig.mcp.servers.srv = { ...httpServer };
    clientConnected = false;
    clientLastError = null;

    const update = findRoute("internal_mcp_update");
    const result = await update.handler({
      body: { name: "srv", defaultRiskLevel: "medium" },
    });

    expect(result).toEqual({ updated: true, status: "needs-auth" });
    expect(connectCalls).toEqual(["srv"]);
  });

  test("verify:false skips the probe", async () => {
    rawConfig.mcp.servers.srv = { ...httpServer };

    const update = findRoute("internal_mcp_update");
    const result = await update.handler({
      body: { name: "srv", verify: false },
    });

    expect(result).toEqual({ updated: true });
    expect(connectCalls).toEqual([]);
  });

  test("a server disabled by the update is not probed", async () => {
    rawConfig.mcp.servers.srv = { ...httpServer };

    const update = findRoute("internal_mcp_update");
    const result = await update.handler({
      body: { name: "srv", enabled: false },
    });

    expect(result).toEqual({ updated: true });
    expect(connectCalls).toEqual([]);
  });
});

describe("internal_mcp_list — live manager state", () => {
  test("a live-connected server reports connected without a probe", async () => {
    rawConfig.mcp.servers.live = { ...httpServer };
    connectedServers.add("live");
    // A probe, if it ran, would report a non-connected status.
    clientConnected = false;
    clientLastError = new Error("would-be error");

    const list = findRoute("internal_mcp_list");
    const { servers } = (await list.handler({})) as {
      servers: Array<{ id: string; status: string }>;
    };

    expect(servers.find((s) => s.id === "live")?.status).toBe("connected");
    expect(connectCalls).toEqual([]);
  });

  test("a server without a live connection falls back to the probe", async () => {
    rawConfig.mcp.servers.dead = { ...httpServer };
    clientConnected = false;
    clientLastError = new Error("refused");

    const list = findRoute("internal_mcp_list");
    const { servers } = (await list.handler({})) as {
      servers: Array<{ id: string; status: string }>;
    };

    expect(servers.find((s) => s.id === "dead")?.status).toBe("error");
    expect(connectCalls).toEqual(["dead"]);
  });
});
