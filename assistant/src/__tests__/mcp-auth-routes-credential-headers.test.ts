import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Module mocks (must precede imports) ───────────────────────────────────────

let rawConfig: {
  mcp: { servers: Record<string, Record<string, unknown>> };
};

mock.module("../config/loader.js", () => ({
  loadRawConfig: () => rawConfig,
  saveRawConfig: (c: typeof rawConfig) => {
    rawConfig = c;
  },
  getConfig: () => rawConfig,
  getConfigReadOnly: () => rawConfig,
}));

mock.module("../daemon/mcp-reload-service.js", () => ({
  reloadMcpServers: async () => {},
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

mock.module("../mcp/client.js", () => ({
  McpClient: class {
    constructor(_id: string) {}
    async connect() {}
    get isConnected() {
      return true;
    }
    get lastError() {
      return null;
    }
    async disconnect() {}
  },
}));

// In-memory secure key backend. Spread the real module so exports consumed
// elsewhere in the route graph (e.g. getProviderKeyAsync) stay intact.
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

// Credentials that "exist" in the vault, keyed by "service/field".
const existingCredentials = new Map<string, string>();
const realResolve = await import("../tools/credentials/resolve.js");

mock.module("../tools/credentials/resolve.js", () => ({
  ...realResolve,
  resolveCredentialRef: (ref: string) => {
    const storageKey = existingCredentials.get(ref);
    if (!storageKey) {
      return undefined;
    }
    const [service, field] = ref.split("/");
    return {
      credentialId: ref,
      service,
      field,
      storageKey,
      injectionTemplates: [],
      metadata: {},
    };
  },
}));

// ── Import SUT after mocks ────────────────────────────────────────────────────

const { ROUTES } = await import("../runtime/routes/mcp-auth-routes.js");

function findRoute(operationId: string) {
  const route = ROUTES.find((r) => r.operationId === operationId);
  if (!route) {
    throw new Error(`Route ${operationId} not found`);
  }
  return route;
}

function storedEnvelope(serverId: string) {
  const raw = secureStore.get(`mcp:${serverId}:headers`);
  return raw ? JSON.parse(raw) : undefined;
}

beforeEach(() => {
  rawConfig = { mcp: { servers: {} } };
  secureStore.clear();
  existingCredentials.clear();
});

describe("mcp add — credential-reference headers", () => {
  test("stores --auth-credential as a ref, never a literal", async () => {
    existingCredentials.set("reducto/api_key", "credkey-1");
    const add = findRoute("internal_mcp_add");

    const result = await add.handler({
      body: {
        name: "reducto",
        transportType: "streamable-http",
        url: "https://mcp.reducto.ai/mcp",
        authCredential: "reducto/api_key",
        authHeader: "Authorization",
        authPrefix: "Bearer ",
      },
    });

    expect(result).toEqual({ added: true });
    expect(storedEnvelope("reducto")).toEqual({
      version: 2,
      literals: {},
      refs: [
        {
          headerName: "Authorization",
          service: "reducto",
          field: "api_key",
          prefix: "Bearer ",
        },
      ],
    });
  });

  test("parses {{credential:...}} placeholder in -H into a ref with prefix", async () => {
    existingCredentials.set("reducto/api_key", "credkey-1");
    const add = findRoute("internal_mcp_add");

    await add.handler({
      body: {
        name: "reducto",
        transportType: "streamable-http",
        url: "https://mcp.reducto.ai/mcp",
        headers: { Authorization: "Bearer {{credential:reducto/api_key}}" },
      },
    });

    expect(storedEnvelope("reducto")).toEqual({
      version: 2,
      literals: {},
      refs: [
        {
          headerName: "Authorization",
          service: "reducto",
          field: "api_key",
          prefix: "Bearer ",
        },
      ],
    });
  });

  test("rejects an empty header value", async () => {
    const add = findRoute("internal_mcp_add");
    await expect(
      add.handler({
        body: {
          name: "srv",
          transportType: "streamable-http",
          url: "https://srv.example.com/mcp",
          headers: { "X-API-Key": "" },
        },
      }),
    ).rejects.toMatchObject({
      name: "BadRequestError",
      message: expect.stringContaining("empty"),
    });
  });

  test("rejects a header containing a shell env var and points to --auth-credential", async () => {
    const add = findRoute("internal_mcp_add");
    await expect(
      add.handler({
        body: {
          name: "srv",
          transportType: "streamable-http",
          url: "https://srv.example.com/mcp",
          headers: { Authorization: "Bearer ${REDUCTO_API_KEY}" },
        },
      }),
    ).rejects.toMatchObject({
      name: "BadRequestError",
      message: expect.stringContaining("--auth-credential"),
    });
  });

  test("missing credential error includes the exact prompt command", async () => {
    const add = findRoute("internal_mcp_add");
    await expect(
      add.handler({
        body: {
          name: "reducto",
          transportType: "streamable-http",
          url: "https://mcp.reducto.ai/mcp",
          authCredential: "reducto/api_key",
          authHeader: "Authorization",
          authPrefix: "Bearer ",
        },
      }),
    ).rejects.toMatchObject({
      name: "BadRequestError",
      message: expect.stringContaining(
        "assistant credentials prompt --service reducto --field api_key",
      ),
    });
    // Server must not be half-written when the credential is missing.
    expect(rawConfig.mcp.servers.reducto).toBeUndefined();
  });

  test("rejects static auth on stdio transports", async () => {
    const add = findRoute("internal_mcp_add");
    await expect(
      add.handler({
        body: {
          name: "local",
          transportType: "stdio",
          command: "npx",
          authCredential: "reducto/api_key",
        },
      }),
    ).rejects.toMatchObject({
      name: "BadRequestError",
      message: expect.stringContaining("sse/streamable-http"),
    });
  });
});

describe("mcp list — authType with refs", () => {
  test("reports bearer auth for an Authorization ref without leaking values", async () => {
    rawConfig.mcp.servers.reducto = {
      transport: { type: "streamable-http", url: "https://mcp.reducto.ai/mcp" },
      enabled: true,
      defaultRiskLevel: "high",
    };
    secureStore.set(
      "mcp:reducto:headers",
      JSON.stringify({
        version: 2,
        literals: {},
        refs: [
          {
            headerName: "Authorization",
            service: "reducto",
            field: "api_key",
            prefix: "Bearer ",
          },
        ],
      }),
    );

    const list = findRoute("internal_mcp_list");
    const { servers } = (await list.handler({})) as {
      servers: Array<Record<string, unknown>>;
    };
    const entry = servers.find((s) => s.id === "reducto");

    expect(entry).toMatchObject({
      hasStaticAuth: true,
      authType: "bearer",
    });
    expect(entry?.authHeaderName).toBeUndefined();
    expect(JSON.stringify(entry?.transport)).not.toContain("Authorization");
  });

  test("reports api-key auth and the header name for a non-Authorization ref", async () => {
    rawConfig.mcp.servers.acme = {
      transport: {
        type: "streamable-http",
        url: "https://acme.example.com/mcp",
      },
      enabled: true,
      defaultRiskLevel: "high",
    };
    secureStore.set(
      "mcp:acme:headers",
      JSON.stringify({
        version: 2,
        literals: {},
        refs: [{ headerName: "X-API-Key", service: "acme", field: "key" }],
      }),
    );

    const list = findRoute("internal_mcp_list");
    const { servers } = (await list.handler({})) as {
      servers: Array<Record<string, unknown>>;
    };
    const entry = servers.find((s) => s.id === "acme");

    expect(entry).toMatchObject({
      hasStaticAuth: true,
      authType: "api-key",
      authHeaderName: "X-API-Key",
    });
  });
});
